import express from "express"
import http from "http"
import * as vscode from "vscode"
import path from "path" // Added for path resolution
import fs from "fs" // Added for file system access
// Use CommonJS require for WebSocket to avoid typing issues
// eslint-disable-next-line @typescript-eslint/no-var-requires
const WebSocketServer = require("ws").Server
import { EventEmitter } from "events"
import { Buffer } from "buffer"
import { ClineProvider, ClineProviderEvents } from "../../core/webview/ClineProvider" // Import events type
import { API } from "../../exports/api"
import { ClineMessage, ApiConfigMeta, ProviderSettings } from "../../schemas"
import { Cline } from "../../core/Cline" // Import Cline type
import { getModeBySlug, modes as builtInModes } from "../../shared/modes" // Import built-in modes
// WebSocket constants that should be available
const WS_OPEN = 1 // WebSocket.OPEN value

/**
 * RemoteServer provides an HTTP and WebSocket server to allow remote control
 * of the Roo Code extension from external devices like mobile phones.
 */
export class RemoteServer {
	private app: express.Express
	private server: http.Server
	private wss: any // Use any to avoid TypeScript issues with ws types
	private outputChannel: vscode.OutputChannel
	private provider: ClineProvider
	private api: API
	private frontendDir: string // Path to the built React frontend
	private activeConnections: Set<any> = new Set()
	private port: number

	// Helper methods to make the code more readable
	private log(message: string): void {
		this.outputChannel.appendLine(`[RemoteServer] ${message}`)
	}

	private setupWebSocket(): void {
		// Log WebSocket setup
		this.log(`Setting up WebSocket server on path /ws for port ${this.port}`)

		this.wss.on("connection", (socket: any) => {
			// Use 'any' type for WebSocket to avoid TypeScript errors
			this.log("New WebSocket connection established")

			// Add error handling for WebSocket
			socket.on("error", (err: Error) => {
				this.log(`WebSocket error: ${err.message}`)
			})
			this.activeConnections.add(socket)

			// Send current state immediately upon connection
			this.provider
				.getStateToPostToWebview()
				.then((state) => {
					if (socket.readyState === WS_OPEN) {
						socket.send(JSON.stringify({ type: "state_update", payload: state }))
					}
				})
				.catch((err) => {
					this.log(`Error sending initial state: ${err instanceof Error ? err.message : String(err)}`)
				})

			// Clean up on connection close
			socket.on("close", () => {
				this.activeConnections.delete(socket)
				this.log("WebSocket connection closed")
			})

			// Listen for messages from clients (e.g., sending a message)
			socket.on("message", async (message: any) => {
				try {
					// Convert Buffer or ArrayBuffer to string if needed
					const messageStr =
						message instanceof Buffer
							? message.toString("utf-8")
							: message instanceof ArrayBuffer
								? new TextDecoder().decode(message)
								: message.toString()

					const data = JSON.parse(messageStr)
					this.log(`Received WebSocket message: ${JSON.stringify(data)}`)

					switch (data.type) {
						case "send_message":
							if (data.payload && (data.payload.text || data.payload.images)) {
								if (!this.provider.getCurrentCline()) {
									await this.provider.initClineWithTask(data.payload.text, data.payload.images)
								} else {
									await this.api.sendMessage(data.payload.text, data.payload.images)
								}
							}
							break
						case "new_conversation":
							await this.api.startNewTask(data) // Clears the current task
							// Optionally send a confirmation or the new empty state
							break
						case "switch_mode": {
							const modeSlug = data.payload?.mode
							if (modeSlug) {
								this.log(`Client requested mode switch to: ${modeSlug}`)
								try {
									// Find the full mode object (including name) using the slug
									const { customModes } = await this.provider.getState()
									const modeToSwitch = getModeBySlug(modeSlug, customModes)

									if (modeToSwitch) {
										// Switch the mode
										await this.provider.handleModeSwitch(modeToSwitch.slug)

										// Send explicit mode_switched confirmation to the client that requested it
										if (socket.readyState === WS_OPEN) {
											socket.send(
												JSON.stringify({
													type: "mode_switched",
													payload: {
														mode: modeSlug,
														modeName: modeToSwitch.name,
													},
												}),
											)
										}

										// Force a full state update to ensure all clients are in sync
										const state = await this.provider.getStateToPostToWebview()
										this.broadcast({ type: "state_update", payload: state })

										this.log(`Successfully switched mode to: ${modeSlug}`)
									} else {
										this.log(`Error: Mode with slug '${modeSlug}' not found.`)
										// Optionally send an error back to the client
										if (socket.readyState === WS_OPEN) {
											socket.send(
												JSON.stringify({
													type: "error",
													payload: { message: `Mode '${modeSlug}' not found.` },
												}),
											)
										}
									}
								} catch (err) {
									this.log(
										`Error switching mode: ${err instanceof Error ? err.message : String(err)}`,
									)
									if (socket.readyState === WS_OPEN) {
										socket.send(
											JSON.stringify({
												type: "error",
												payload: {
													message: `Failed to switch mode: ${err instanceof Error ? err.message : String(err)}`,
												},
											}),
										)
									}
								}
							}
							break
						}
						case "set_model": {
							const modelId = data.payload?.modelId
							if (modelId) {
								this.log(`Client requested model change to ID: ${modelId}`)
								try {
									// Find the profile name associated with the ID
									const profiles = this.api.getConfiguration().listApiConfigMeta || []
									const profile = profiles.find((p) => p.id === modelId)

									if (profile?.name) {
										// 1. Load config by ID. This also sets it as the active config internally.
										this.log(`Loading config by ID and setting as active: ${modelId}`)
										const { config: apiConfig, name: loadedName } =
											await this.provider.providerSettingsManager.loadConfigById(modelId)

										// Verify the loaded name matches the expected profile name (sanity check)
										if (loadedName !== profile.name) {
											this.log(
												`Warning: Name mismatch. Profile found: ${profile.name}, Loaded config name: ${loadedName}`,
											)
											// Trust the loaded name if there's a mismatch, which we do by using loadedName below.
										}

										// 2. Update the global state context with the active name
										this.log(`Updating contextProxy currentApiConfigName: ${loadedName}`)
										await this.provider.contextProxy.setValue("currentApiConfigName", loadedName)

										this.log(`Updating technical API configuration object for ${loadedName}`)
										await this.provider.updateApiConfiguration(apiConfig)

										// 4. Set the active profile in the provider
										await this.provider.postStateToWebview()

										// Send explicit model_switched confirmation to the client that requested it
										if (socket.readyState === WS_OPEN) {
											socket.send(
												JSON.stringify({
													type: "model_switched",
													payload: {
														modelId: modelId,
														profileName: profile.name,
													},
												}),
											)
										}

										// Force a full state update to all clients
										const state = await this.provider.getStateToPostToWebview()

										// Broadcast the updated state to all clients
										this.broadcast({ type: "state_update", payload: state })

										this.log(`Successfully set active profile: ${loadedName} (ID: ${modelId})`) // Use loadedName for accuracy
									} else {
										this.log(`Error: Profile with ID '${modelId}' not found.`)
										if (socket.readyState === WS_OPEN) {
											socket.send(
												JSON.stringify({
													type: "error",
													payload: { message: `Profile with ID '${modelId}' not found.` },
												}),
											)
										}
									}
								} catch (err) {
									this.log(
										`Error setting active profile: ${err instanceof Error ? err.message : String(err)}`,
									)
									if (socket.readyState === WS_OPEN) {
										socket.send(
											JSON.stringify({
												type: "error",
												payload: {
													message: `Failed to set profile: ${err instanceof Error ? err.message : String(err)}`,
												},
											}),
										)
									}
								}
							}
							break
						}
						case "tool_response":
							if (data.payload && data.payload.approve !== undefined) {
								this.log(`Received tool response: ${JSON.stringify(data.payload)}`)

								try {
									if (data.payload.approve) {
										this.log("Approving tool use")
										await this.api.pressPrimaryButton()

										// Send confirmation message to clients
										this.broadcast({
											type: "cline_message",
											payload: {
												type: "system",
												role: "system",
												messageType: "system",
												text: "Tool approved",
												approved: true,
												ts: Date.now(), // Add timestamp for proper ordering
											},
										})
									} else {
										this.log("Rejecting tool use")
										await this.api.pressSecondaryButton()

										// Send rejection message to clients
										this.broadcast({
											type: "cline_message",
											payload: {
												type: "system",
												role: "system",
												messageType: "system",
												text: "Tool rejected",
												denied: true,
												ts: Date.now(), // Add timestamp for proper ordering
											},
										})

										// Handle additional feedback if provided
										if (data.payload.text) {
											this.log(`Sending additional feedback: ${data.payload.text}`)
											setTimeout(async () => {
												await this.api.sendMessage(data.payload.text)
											}, 500)
										}
									}

									// Force a state update to ensure UI is refreshed
									const state = await this.provider.getStateToPostToWebview()
									this.broadcast({ type: "state_update", payload: state })
								} catch (error) {
									this.log(
										`Error handling tool response: ${error instanceof Error ? error.message : String(error)}`,
									)
									this.broadcast({
										type: "cline_message",
										payload: {
											type: "system",
											role: "system",
											messageType: "error",
											text: `Error handling tool response: ${error instanceof Error ? error.message : String(error)}`,
											ts: Date.now(), // Add timestamp for proper ordering
										},
									})
								}
							}
							break
						case "cancel_task":
							this.log("Client requested task cancellation")
							await this.api.cancelCurrentTask()
							// Optionally send confirmation
							break
						case "human_relay_response":
							this.log(`Received Human Relay Response: ${JSON.stringify(data.payload)}`)
							// TODO: Implement logic to forward this response to the appropriate handler if needed
							break
						case "human_relay_cancel":
							this.log(`Received Human Relay Cancel: ${JSON.stringify(data.payload)}`)
							// TODO: Implement logic to forward this cancellation if needed
							break
						// Add other message types as needed
					}
				} catch (err) {
					this.log(`Error processing WebSocket message: ${err instanceof Error ? err.message : String(err)}`)
				}
			})
		})

		// Register message listener on the API to forward messages to WebSocket clients
		this.registerMessageListener()
	}

	constructor(outputChannel: vscode.OutputChannel, provider: ClineProvider, api: API, port = 9876) {
		this.outputChannel = outputChannel
		this.provider = provider
		this.api = api
		this.port = port

		// Determine the frontend directory relative to extension path
		const extensionPath = vscode.extensions.getExtension("Roo-Labs.roocode")?.extensionPath || __dirname

		const frontendBuildPath = path.join(extensionPath, "frontend", "build")
		const webviewUiPath = path.join(extensionPath, "webview-ui", "build")

		// Additional fallbacks for development scenarios
		const fallbackPaths = [
			webviewUiPath, // Webview UI build from official Roo Code
			path.join(extensionPath, "..", "frontend", "build"), // During development
		]

		if (fs.existsSync(frontendBuildPath)) {
			this.frontendDir = frontendBuildPath
			this.log(`Serving webview-ui frontend from: ${this.frontendDir}`)
		} else {
			// Try fallback paths
			const existingFallback = fallbackPaths.find((p) => fs.existsSync(p))
			if (existingFallback) {
				this.frontendDir = existingFallback
				this.log(`Using fallback frontend path: ${existingFallback}`)
			} else {
				// No frontend build found, serve minimal page
				this.frontendDir = ""
				this.log(
					"No frontend build found (frontend-build, webview-ui/build, or fallbacks). Will serve minimal UI.",
				)
			}
		}

		this.app = express()
		this.server = http.createServer(this.app)
		this.wss = new WebSocketServer({ server: this.server, path: "/ws" }) // Define WebSocket path
		this.setupExpress()
		this.setupWebSocket()
	}

	/**
	 * Starts the server on the specified port
	 */
	public start(): Promise<void> {
		this.log(`Attempting to start remote server on port ${this.port}`)

		// Check if the frontend directory is properly set
		if (this.frontendDir) {
			this.log(`Frontend directory path: ${this.frontendDir}`)
			if (fs.existsSync(this.frontendDir)) {
				this.log(`Frontend directory exists. Content: ${fs.readdirSync(this.frontendDir).join(", ")}`)
			} else {
				this.log(`WARNING: Frontend directory does not exist: ${this.frontendDir}`)
			}
		} else {
			this.log(`WARNING: Frontend directory not set. Will serve minimal UI.`)
		}

		return new Promise((resolve) => {
			this.server.listen(this.port, () => {
				this.log(`Remote server started on port ${this.port}`)

				// Get local IP addresses to make it easier to connect
				const networkInterfaces = require("os").networkInterfaces()
				const localIPs: string[] = []

				Object.keys(networkInterfaces).forEach((ifName) => {
					networkInterfaces[ifName].forEach((iface: any) => {
						if (iface.family === "IPv4" && !iface.internal) {
							localIPs.push(iface.address)
						}
					})
				})

				// Notify VSCode that the server is ready with more helpful connection info
				const ipInfo =
					localIPs.length > 0
						? `Available on your network at: ${localIPs.map((ip) => `http://${ip}:${this.port}`).join(", ")}`
						: ""

				vscode.window.showInformationMessage(
					`Roo Code remote server started on port ${this.port}. ` +
						`Open http://localhost:${this.port} in your browser. ${ipInfo}`,
				)
				resolve()
			})
		})
	}

	/**
	 * Stops the server
	 */
	public stop(): Promise<void> {
		return new Promise((resolve, reject) => {
			// Close all websocket connections
			this.log(`Closing ${this.activeConnections.size} WebSocket connections...`)
			for (const conn of this.activeConnections) {
				conn.close()
			}
			this.activeConnections.clear() // Clear the set

			// Close the server
			this.log("Closing HTTP server...")
			this.server.close((err: Error | undefined) => {
				if (err) {
					this.log(`Error closing remote server: ${err.message}`)
					reject(err)
				} else {
					this.log("Remote server stopped")
					resolve()
				}
			})
		})
	}

	private setupExpress() {
		this.log(`Setting up Express server on port ${this.port}`)
		this.app.use(express.json())

		// Set up CORS headers for cross-origin requests (adjust origin in production)
		this.app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
			res.header("Access-Control-Allow-Origin", "*") // Allow any origin for simplicity, restrict in production
			res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept")
			if (req.method === "OPTIONS") {
				return res.sendStatus(200)
			}
			return next()
		})

		// Log all requests
		this.app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
			this.log(`HTTP ${req.method} ${req.path}`)
			next()
		})

		// Status endpoint
		this.app.get("/api/status", (req: express.Request, res: express.Response) => {
			res.json({
				status: "ok",
				version: vscode.extensions.getExtension("Rooveterinaryinc.roo-cline")?.packageJSON.version || "unknown",
				websocketConnections: this.activeConnections.size,
			})
		})

		// Get current conversation state
		this.app.get("/api/conversation", async (req: express.Request, res: express.Response) => {
			try {
				const state = await this.provider.getStateToPostToWebview()
				res.json(state)
			} catch (err) {
				this.log(`Error getting conversation state: ${err instanceof Error ? err.message : String(err)}`)
				res.status(500).json({ error: "Failed to retrieve conversation state" })
			}
		})

		// Send a message (handled via WebSocket now, but keep for potential REST use)
		this.app.post("/api/message", async (req: express.Request, res: express.Response) => {
			const { text, images } = req.body

			if (!text && (!images || !images.length)) {
				return res.status(400).json({ error: "Message text or images required" })
			}

			try {
				if (!this.provider.getCurrentCline()) {
					await this.provider.initClineWithTask(text, images)
				} else {
					await this.api.sendMessage(text, images)
				}
				return res.status(202).json({ status: "accepted" })
			} catch (err) {
				this.log(`Error sending message via POST: ${err instanceof Error ? err.message : String(err)}`)
				return res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
			}
		})

		// Start a new conversation (handled via WebSocket now)
		this.app.post("/api/conversation", async (req: express.Request, res: express.Response) => {
			try {
				await this.api.cancelCurrentTask() // Clear existing task
				// Optionally initialize with a new task if text/images provided
				const { text, images } = req.body
				if (text || (images && images.length > 0)) {
					await this.provider.initClineWithTask(text, images)
				}
				res.status(201).json({ status: "new conversation started" })
			} catch (err) {
				this.log(
					`Error starting new conversation via POST: ${err instanceof Error ? err.message : String(err)}`,
				)
				res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
			}
		})

		// Clear current conversation (handled via WebSocket now)
		this.app.delete("/api/conversation", async (req: express.Request, res: express.Response) => {
			try {
				await this.api.cancelCurrentTask()
				res.json({ status: "success" })
			} catch (err) {
				res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
			}
		})

		// Respond to tool usage approvals (handled via WebSocket now)
		this.app.post("/api/tool-response", async (req: express.Request, res: express.Response) => {
			const { approve, text } = req.body

			if (approve === undefined) {
				return res.status(400).json({ error: "Approval status required" })
			}

			try {
				if (approve) {
					await this.api.pressPrimaryButton()

					// Send confirmation message to clients
					this.broadcast({
						type: "cline_message",
						payload: {
							type: "system",
							role: "system",
							messageType: "system",
							text: "Tool approved",
							approved: true,
						},
					})
				} else {
					await this.api.pressSecondaryButton()

					// Send rejection message to clients
					this.broadcast({
						type: "cline_message",
						payload: {
							type: "system",
							role: "system",
							messageType: "system",
							text: "Tool rejected",
							denied: true,
						},
					})

					if (text) {
						setTimeout(async () => {
							await this.api.sendMessage(text)
						}, 500)
					}
				}

				// Force a state update to ensure UI is refreshed
				const state = await this.provider.getStateToPostToWebview()
				this.broadcast({ type: "state_update", payload: state })

				return res.json({ status: "success" })
			} catch (err) {
				return res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
			}
		})

		// Serve configuration data
		this.app.get("/api/config", async (req: express.Request, res: express.Response) => {
			try {
				const state = await this.provider.getState()
				// Combine built-in modes with custom modes from state
				const allModes = [...builtInModes, ...(state.customModes || [])]

				res.json({
					modes: allModes.map((m) => ({ slug: m.slug, name: m.name })), // Send only slug and name
					currentMode: state.mode, // Get the actual current mode slug
					apiConfiguration: state.apiConfiguration, // Get current API config (includes model ID)
				})
			} catch (error) {
				this.log(`Error fetching config: ${error instanceof Error ? error.message : String(error)}`)
				res.status(500).json({
					error: `Failed to fetch config: ${error instanceof Error ? error.message : String(error)}`,
				})
			}
		})

		// Serve available LLM profiles (models)
		this.app.get("/api/profiles", async (req: express.Request, res: express.Response) => {
			try {
				// Get the list of profile metadata (includes id, name, provider)
				const profilesMeta = this.api.getConfiguration().listApiConfigMeta || []
				// Format for the frontend (needs id and name)
				const profiles = profilesMeta.map((p: ApiConfigMeta) => ({ id: p.id, name: p.name }))
				res.json(profiles)
			} catch (error) {
				this.log(`Error fetching profiles: ${error instanceof Error ? error.message : String(error)}`)
				res.status(500).json({
					error: `Failed to fetch profiles: ${error instanceof Error ? error.message : String(error)}`,
				})
			}
		})

		// Get pending tool approval status
		this.app.get("/api/pending-approvals", async (req: express.Request, res: express.Response) => {
			try {
				// Get the current state from the provider
				const state = (await this.provider.getStateToPostToWebview()) as any

				this.log(
					`Checking for pending approvals in state: ${JSON.stringify({
						hasPendingAsk: !!state?.pendingAsk,
						hasPendingToolUse: !!state?.pendingToolUse,
						hasActiveAsk: !!state?.activeAsk,
						hasApprovalButtons: !!state?.webviewState?.showApprovalButtons,
					})}`,
				)

				// Check if there's a pending approval in the state
				// We use a type assertion (as any) to avoid TypeScript errors since the exact state structure may vary
				const hasPendingApproval =
					state &&
					(state.pendingAsk ||
						state.pendingToolUse ||
						state.activeAsk ||
						(state.webviewState && state.webviewState.showApprovalButtons))

				// Also check if there are any messages in the state that require tool approval
				const hasToolApprovalMessage = state?.clineMessages?.some(
					(msg: any) => msg.messageType === "tool_approval" && !msg.approved && !msg.denied,
				)

				if (hasPendingApproval || hasToolApprovalMessage) {
					// Return information about the pending approval
					const details: any = {}

					if (state.pendingAsk) details.pendingAsk = state.pendingAsk
					if (state.pendingToolUse) details.pendingToolUse = state.pendingToolUse
					if (state.activeAsk) details.activeAsk = state.activeAsk
					if (state.webviewState?.showApprovalButtons)
						details.showApprovalButtons = state.webviewState.showApprovalButtons

					// If we found a tool approval message, include its details
					if (hasToolApprovalMessage) {
						const toolMessage = state.clineMessages.find(
							(msg: any) => msg.messageType === "tool_approval" && !msg.approved && !msg.denied,
						)
						if (toolMessage) {
							details.toolApprovalMessage = toolMessage
						}
					}

					this.log(`Found pending approval: ${JSON.stringify(details)}`)
					return res.json({
						hasPendingApproval: true,
						details,
					})
				}

				// No pending approval found
				this.log("No pending approvals found")
				return res.json({ hasPendingApproval: false })
			} catch (error) {
				this.log(`Error checking pending approvals: ${error instanceof Error ? error.message : String(error)}`)
				return res.status(500).json({
					error: `Failed to check pending approvals: ${error instanceof Error ? error.message : String(error)}`,
				})
			}
		})

		// Remove the old POST /api/mode endpoint as it's handled via WebSocket

		// Simple health check endpoint
		this.app.get("/health", (req: express.Request, res: express.Response) => {
			res.status(200).send("OK")
		})

		// Catch-all for undefined API routes
		this.app.use("/api/*", (req, res) => {
			res.status(404).json({ error: "API endpoint not found" })
		})

		// Serve the React frontend if available
		if (this.frontendDir && fs.existsSync(this.frontendDir)) {
			this.log(`Serving React frontend from: ${this.frontendDir}`)

			// Serve static React app files
			this.app.use(express.static(this.frontendDir))

			// For any route not matching an API route or static file, serve the React app's index.html
			// This is needed for client-side routing to work
			this.app.get("*", (req, res, next) => {
				// Skip API routes
				if (req.path.startsWith("/api/") || req.path === "/ws" || req.path === "/health") {
					return next()
				}

				// Serve the index.html file
				const indexPath = path.join(this.frontendDir, "index.html")
				if (fs.existsSync(indexPath)) {
					res.sendFile(indexPath)
				} else {
					next() // Continue to minimal UI if index.html not found
				}
			})
		} else {
			// If no frontend directory is available, serve a minimal UI for the root route
			// Handle the root route
			this.app.get("/", (req, res) => {
				res.send(`
					<html>
						<head>
							<title>Roo Code Remote Server</title>
							<style>
								body { font-family: Arial, sans-serif; margin: 40px; line-height: 1.6; }
								h1 { color: #333; }
								.container { max-width: 800px; margin: 0 auto; }
								.api-link { margin-top: 20px; }
								code { background: #f4f4f4; padding: 2px 5px; border-radius: 3px; }
							</style>
						</head>
						<body>
							<div class="container">
								<h1>Roo Code Remote Server</h1>
								<p>The remote server is running successfully on port ${this.port}.</p>
								<p>This is a minimal interface since the frontend build was not found.</p>
								<div class="api-link">
									<p>Available API endpoints:</p>
									<ul>
										<li><code>/api/status</code> - Server status</li>
										<li><code>/api/conversation</code> - Current conversation state</li>
										<li><code>/api/config</code> - Configuration data</li>
										<li><code>/api/profiles</code> - Available LLM profiles</li>
										<li><code>/health</code> - Health check endpoint</li>
									</ul>
								</div>
							</div>
						</body>
					</html>
				`)
			})
		}

		// Add a catch-all route for other non-API routes to prevent "Cannot GET" errors
		this.app.get("*", (req, res) => {
			// Skip API routes and health check
			if (req.path.startsWith("/api/") || req.path === "/ws" || req.path === "/health") {
				return res.status(404).json({ error: "API endpoint not found" })
			}
			// Redirect to root for all other routes
			return res.redirect("/")
		})
	}

	/**
	 * Register a listener for messages from the Cline instance
	 * to forward them to connected WebSocket clients
	 */
	private registerMessageListener() {
		// Use the properly typed EventEmitter
		const providerEmitter = this.provider as EventEmitter<ClineProviderEvents>

		// Monitor for new Cline instances
		providerEmitter.on("clineCreated", (cline: Cline) => {
			this.log(`New Cline instance created: ${cline.taskId}`)

			// Listen ONLY for 'message' events from the Cline instance
			cline.on("message", (eventData: { action: "created" | "updated"; message: ClineMessage }) => {
				const { action, message } = eventData // Keep original structure
				// Cast to 'any' for property access workaround if needed, but prefer direct access first
				const msgAny = message as any
				this.log(
					`Received cline message event: action=${action}, type=${message.type}, ask=${message.ask}, say=${message.say}`,
				)

				// For tool approval messages, let broadcastClineMessage handle them
				// to avoid duplicate messages
				if (
					action === "created" &&
					message.type === "ask" &&
					(message.ask === "tool" ||
						message.ask === "command" ||
						message.ask === "use_mcp_server" ||
						message.ask === "browser_action_launch")
				) {
					// Tool approval messages will be handled in broadcastClineMessage
					this.log(`Tool approval message detected, handling in broadcastClineMessage`)
				} else {
					// Broadcast other messages normally
					this.broadcastClineMessage(message)
				}
			})
		})
	}

	/**
	 * Broadcast a Cline message to all connected WebSocket clients
	 */
	private broadcastClineMessage(message: ClineMessage) {
		// Create a properly typed message format
		const msg = message as any // Cast to access potential dynamic properties safely if needed

		// Determine appropriate role based on message type and content
		let role = msg.role
		let finalMessageType = msg.type === "ask" ? msg.ask : msg.say // Default messageType
		// Access optional 'id' property using bracket notation as workaround
		const toolId = msg.id ?? Date.now().toString()

		// Ensure message has a timestamp
		if (!msg.ts) {
			msg.ts = Date.now()
		}

		if (!role) {
			if (msg.type === "say") {
				switch (msg.say) {
					case "api_req_started":
					case "api_req_finished":
					case "api_req_retry_delayed":
					case "error":
					case "completion_result":
						role = "system"
						break
					case "task":
						role = "user"
						break
					default:
						role = "assistant"
				}
			} else if (msg.type === "ask") {
				const askType = msg.ask
				// Check if this 'ask' message requires tool approval
				const isToolApprovalAsk =
					askType === "tool" ||
					askType === "command" ||
					askType === "use_mcp_server" ||
					askType === "browser_action_launch" // Add other relevant ask types

				if (isToolApprovalAsk) {
					role = "system" // Tool approval requests are from the system
					finalMessageType = "tool_approval" // Set specific type for frontend that matches what the UI expects
					const tool_approval_message = {
						type: "tool_approval_required", // Keep this type for backend compatibility
						id: toolId,
						tool: msg.tool || askType, // Use tool name or ask type
						details: msg.text || "", // Send text as details
						ts: Date.now(), // Add timestamp for proper ordering
						partial: msg.partial || false, // Include partial for streaming if available
					}
					this.log(`Broadcasting tool_approval_required: ${JSON.stringify(tool_approval_message)}`)
					this.broadcast(tool_approval_message)
					return
				} else {
					// Handle other ask types
					switch (askType) {
						case "api_req_failed":
						case "mistake_limit_reached":
						case "completion_result":
						case "finishTask": // Assuming this might exist
							role = "system"
							break
						case "followup":
							role = "assistant"
							break
						default: // e.g., resume_task
							role = "user"
					}

					// Format the message for the WebSocket clients
					const formattedMessage = {
						type: "cline_message", // Use a specific type for Cline messages
						payload: {
							...message, // Spread the original message
							// Ensure essential fields are present
							role: role,
							text: msg.text || msg.content || "",
							tool: msg.tool || null, // Ensure tool is included if present
							id: toolId || null, // Ensure id is included if present
							messageType: finalMessageType, // Use the determined messageType
							ts: msg.ts, // Include the timestamp
						},
					}

					this.log(
						`Broadcasting formatted cline_message: type=${formattedMessage.payload.messageType}, role=${formattedMessage.payload.role}, id=${formattedMessage.payload.id}`,
					)
					this.broadcast(formattedMessage)
				}
			}
		}
	}

	/**
	 * Broadcast a generic message to all connected WebSocket clients
	 */
	private broadcast(message: any) {
		if (this.activeConnections.size === 0) {
			return // No clients connected
		}
		const messageStr = JSON.stringify(message)
		this.log(`Broadcasting message: ${messageStr.substring(0, 100)}... (${this.activeConnections.size} clients)`)
		for (const client of this.activeConnections) {
			if (client.readyState === WS_OPEN) {
				client.send(messageStr, (err: Error | undefined) => {
					if (err) {
						this.log(`Error sending message to client: ${err.message}`)
						// Optionally remove client if send fails repeatedly
					}
				})
			}
		}
	}
}
