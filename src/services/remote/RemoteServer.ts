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
import { ClineProvider } from "../../core/webview/ClineProvider"
import { API } from "../../exports/api"
import { ClineMessage, ApiConfigMeta } from "../../schemas"
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
										// Set the active profile
										await this.api.setActiveProfile(profile.name)

										// Get the updated configuration with the new profile
										const updatedConfig = this.api.getConfiguration()

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

										// State should already include the updated configuration
										// since we called setActiveProfile which updates the state
										this.broadcast({ type: "state_update", payload: state })

										this.log(`Successfully set active profile to: ${profile.name} (ID: ${modelId})`)
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
								if (data.payload.approve) {
									await this.api.pressPrimaryButton()
								} else {
									await this.api.pressSecondaryButton()
									if (data.payload.text) {
										setTimeout(async () => {
											await this.api.sendMessage(data.payload.text)
										}, 500)
									}
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

		const webviewUiPath = path.join(extensionPath, "webview-ui", "build")
		// Additional fallbacks for development scenarios
		const fallbackPaths = [
			path.join(extensionPath, "frontend", "build"), // Frontend build output
			path.join(extensionPath, "..", "frontend", "build"), // During development
		]

		if (fs.existsSync(webviewUiPath)) {
			this.frontendDir = webviewUiPath
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
				} else {
					await this.api.pressSecondaryButton()
					if (text) {
						setTimeout(async () => {
							await this.api.sendMessage(text)
						}, 500)
					}
				}
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
		}
	}

	/**
	 * Register a listener for messages from the Cline instance
	 * to forward them to connected WebSocket clients
	 */
	private registerMessageListener() {
		// Configure EventEmitter interface for the provider
		const provider = this.provider as unknown as EventEmitter

		// Monitor for new Cline instances
		provider.on("clineCreated", (cline: any) => {
			this.log(`New Cline instance created: ${cline.taskId}`)
			// Listen for messages from the Cline
			cline.on("message", (message: { message: ClineMessage }) => {
				this.broadcastClineMessage(message.message)
			})

			// Listen for ask events (tool approvals)
			cline.on("ask", (askMessage: any) => {
				// Check if it's a tool approval ask
				if (
					askMessage.ask &&
					(askMessage.ask.tool || askMessage.ask.command || askMessage.ask.use_mcp_server)
				) {
					const toolDetails = askMessage.ask.tool || askMessage.ask.command || askMessage.ask.use_mcp_server
					const toolMessage = {
						type: "tool_approval_required",
						id: Date.now().toString(), // Simple ID for tracking response
						tool: toolDetails.tool || toolDetails.command || toolDetails.serverName, // Extract relevant name
						details: JSON.stringify(askMessage.ask, null, 2),
					}
					this.broadcast(toolMessage)
				} else {
					// Broadcast other ask types if needed by the frontend
					this.broadcast({ type: "ask", payload: askMessage })
				}
			})

			// Listen for state changes to broadcast
			cline.on("stateChanged", async () => {
				try {
					const state = await this.provider.getStateToPostToWebview()
					this.broadcast({ type: "state_update", payload: state })
				} catch (err) {
					this.log(`Error broadcasting state update: ${err instanceof Error ? err.message : String(err)}`)
				}
			})
		})

		// Also listen for state changes directly on the provider (e.g., when task is cleared or model/mode changes)
		provider.on("stateChanged", async () => {
			try {
				// Get the complete state from the provider
				const state = await this.provider.getStateToPostToWebview()

				// Get the current configuration to ensure we have the most up-to-date settings
				const currentConfig = this.api.getConfiguration()

				// Create a comprehensive state object that includes everything needed by clients
				const completeState = {
					...state,
					currentMode: state.mode, // Ensure mode is properly named for frontend
					currentApiConfigName: currentConfig?.currentApiConfigName,
					listApiConfigMeta: currentConfig?.listApiConfigMeta || [],
				}

				// Log the key parts of the state being broadcast for debugging
				this.log(
					`Broadcasting state update: mode=${completeState.mode}, configName=${completeState.currentApiConfigName}`,
				)

				// Broadcast the complete state to all clients
				this.broadcast({ type: "state_update", payload: completeState })
			} catch (err) {
				this.log(
					`Error broadcasting state update from provider: ${err instanceof Error ? err.message : String(err)}`,
				)
			}
		})
	}

	/**
	 * Broadcast a Cline message to all connected WebSocket clients
	 */
	private broadcastClineMessage(message: ClineMessage) {
		// Optionally filter messages before broadcasting
		// e.g., skip partial messages if frontend handles streaming differently
		// if (message.partial) {
		// 	return
		// }

		// Create a properly typed message format
		const msg = message as any // Cast to access potential dynamic properties

		// Determine appropriate role based on message type and content
		let role = msg.role
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
				switch (msg.ask) {
					case "tool":
					case "browser_action_launch":
					case "use_mcp_server":
					case "command":
					case "api_req_failed":
					case "mistake_limit_reached":
					case "completion_result":
						role = "system"
						break
					case "followup":
						role = "assistant"
						break
					default:
						role = "user"
				}
			}
		}

		// Format the message for the WebSocket clients
		const formattedMessage = {
			type: "cline_message", // Use a specific type for Cline messages
			payload: {
				...message, // Spread the original message
				// Ensure essential fields are present
				role: role,
				text: msg.text || msg.content || "",
				tool: msg.tool || null,
				// Add message type to help UI handle different message types appropriately
				messageType: msg.type === "ask" ? msg.ask : msg.say,
			},
		}

		this.broadcast(formattedMessage)
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
