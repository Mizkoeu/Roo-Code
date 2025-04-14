import express from "express"
import http from "http"
import * as vscode from "vscode"
// Use CommonJS require for WebSocket to avoid typing issues
// eslint-disable-next-line @typescript-eslint/no-var-requires
const WebSocketServer = require("ws").Server
import { EventEmitter } from "events"
import { Buffer } from "buffer"
import { ClineProvider } from "../../core/webview/ClineProvider"
import { API } from "../../exports/api"
import { ClineMessage } from "../../schemas"

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
	private activeConnections: Set<any> = new Set()
	private port: number

	constructor(outputChannel: vscode.OutputChannel, provider: ClineProvider, api: API, port = 9876) {
		this.outputChannel = outputChannel
		this.provider = provider
		this.api = api
		this.port = port
		this.app = express()
		this.server = http.createServer(this.app)
		this.wss = new WebSocketServer({ server: this.server })
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
				// Notify VSCode that the server is ready
				vscode.window.showInformationMessage(
					`Roo Code remote server started on port ${this.port}. Connect from your mobile device using http://<your-ip>:${this.port}`,
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
			for (const conn of this.activeConnections) {
				conn.close()
			}

			// Close the server
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

		// Set up CORS headers for cross-origin requests
		this.app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
			res.header("Access-Control-Allow-Origin", "*")
			res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept")
			next()
		})

		// Status endpoint
		this.app.get("/status", (req: express.Request, res: express.Response) => {
			res.json({
				status: "ok",
				version: vscode.extensions.getExtension("Roo-Labs.roocode")?.packageJSON.version || "unknown",
			})
		})

		// Get current conversation
		this.app.get("/conversation", (req: express.Request, res: express.Response) => {
			const cline = this.provider.getCurrentCline()
			if (!cline) {
				return res.status(404).json({ error: "No active conversation" })
			}

			this.provider
				.getStateToPostToWebview()
				.then((state) => {
					res.json({
						taskId: cline.taskId,
						messages: state.clineMessages,
					})
				})
				.catch((err) => {
					res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
				})

			// Add a return statement to fix the "not all code paths return a value" error
			return
		})

		// Send a message to the AI
		this.app.post("/message", async (req: express.Request, res: express.Response) => {
			const { text, images } = req.body

			if (!text && (!images || !images.length)) {
				return res.status(400).json({ error: "Message text or images required" })
			}

			try {
				// If there's no active conversation, start a new one
				if (!this.provider.getCurrentCline()) {
					await this.provider.initClineWithTask(text, images)
				} else {
					// Otherwise send a message in the current conversation
					await this.api.sendMessage(text, images)
				}
				return res.status(202).json({ status: "accepted" })
			} catch (err) {
				this.log(`Error sending message: ${err instanceof Error ? err.message : String(err)}`)
				return res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
			}
		})

		// Start a new conversation
		this.app.post("/conversation", async (req: express.Request, res: express.Response) => {
			const { text, images } = req.body

			try {
				const taskId = await this.api.startNewTask({
					configuration: this.api.getConfiguration(),
					text,
					images,
				})

				res.json({ taskId })
			} catch (err) {
				this.log(`Error starting new conversation: ${err instanceof Error ? err.message : String(err)}`)
				res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
			}
		})

		// Clear current conversation
		this.app.delete("/conversation", async (req: express.Request, res: express.Response) => {
			try {
				await this.api.cancelCurrentTask()
				res.json({ status: "success" })
			} catch (err) {
				res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
			}
		})

		// Respond to tool usage approvals
		this.app.post("/tool-response", async (req: express.Request, res: express.Response) => {
			const { approve, text } = req.body

			if (approve === undefined) {
				return res.status(400).json({ error: "Approval status required" })
			}

			try {
				if (approve) {
					await this.api.pressPrimaryButton()
				} else {
					await this.api.pressSecondaryButton()

					// If custom response text is provided, send it after declining
					if (text) {
						// Wait a bit to ensure the UI has updated
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

		// Serve a simple web UI for connecting from mobile devices
		this.app.get("/", (_req: express.Request, res: express.Response) => {
			res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Roo Code Remote Control</title>
          <style>
            body { 
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              max-width: 800px;
              margin: 0 auto;
              padding: 16px;
            }
            textarea {
              width: 100%;
              padding: 8px;
              height: 100px;
              margin-bottom: 8px;
              border-radius: 4px;
              border: 1px solid #ccc;
            }
            button {
              background-color: #007acc;
              color: white;
              border: none;
              padding: 8px 16px;
              border-radius: 4px;
              cursor: pointer;
              margin-right: 8px;
            }
            button:hover {
              background-color: #005999;
            }
            #messages {
              margin-top: 24px;
              border: 1px solid #ccc;
              border-radius: 4px;
              padding: 16px;
              height: 300px;
              overflow-y: auto;
            }
            .message {
              margin-bottom: 16px;
              padding-bottom: 16px;
              border-bottom: 1px solid #eee;
            }
            .user {
              color: #007acc;
              font-weight: bold;
            }
            .assistant {
              color: #4b4b4b;
            }
            .tool {
              color: #b07a0f;
              background: #fffaed;
              padding: 8px;
              border-radius: 4px;
              margin-top: 8px;
            }
            .approval {
              margin-top: 8px;
              padding: 12px;
              background: #f3f3f3;
              border-radius: 4px;
            }
            .approval button {
              margin-top: 8px;
            }
          </style>
        </head>
        <body>
          <h1>Roo Code Remote Control</h1>
          <div>
            <textarea id="message" placeholder="Type your message here..."></textarea>
            <div>
              <button id="send">Send</button>
              <button id="clear">New Conversation</button>
            </div>
          </div>
          <div id="messages"></div>
          
          <script>
            // Connect to WebSocket
            const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const ws = new WebSocket(\`\${wsProtocol}//\${window.location.host}/ws\`);
            const messagesDiv = document.getElementById('messages');
            const messageInput = document.getElementById('message');
            const sendButton = document.getElementById('send');
            const clearButton = document.getElementById('clear');
            
            // Handle received messages
            ws.onmessage = (event) => {
              const data = JSON.parse(event.data);
              
              if (data.type === 'message') {
                // Regular message
                const messageDiv = document.createElement('div');
                messageDiv.classList.add('message');
                messageDiv.classList.add(data.role);
                
                messageDiv.textContent = \`\${data.role === 'user' ? 'You' : 'Assistant'}: \${data.text}\`;
                
                // If it has a tool usage, add it
                if (data.tool) {
                  const toolDiv = document.createElement('div');
                  toolDiv.classList.add('tool');
                  toolDiv.textContent = \`Tool: \${data.tool}\`;
                  messageDiv.appendChild(toolDiv);
                }
                
                messagesDiv.appendChild(messageDiv);
                messagesDiv.scrollTop = messagesDiv.scrollHeight;
              } 
              else if (data.type === 'tool_approval_required') {
                // Tool approval
                const approvalDiv = document.createElement('div');
                approvalDiv.classList.add('approval');
                approvalDiv.innerHTML = \`
                  <div>Tool approval required: \${data.tool}</div>
                  <div>\${data.details || ''}</div>
                  <button class="approve" data-id="\${data.id}">Approve</button>
                  <button class="deny" data-id="\${data.id}">Deny</button>
                \`;
                messagesDiv.appendChild(approvalDiv);
                messagesDiv.scrollTop = messagesDiv.scrollHeight;
                
                // Add click handlers
                approvalDiv.querySelector('.approve').addEventListener('click', () => {
                  fetch('/tool-response', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ approve: true })
                  });
                  approvalDiv.innerHTML = '<div>Tool approved</div>';
                });
                
                approvalDiv.querySelector('.deny').addEventListener('click', () => {
                  fetch('/tool-response', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ approve: false })
                  });
                  approvalDiv.innerHTML = '<div>Tool denied</div>';
                });
              }
            };
            
            // Send message
            sendButton.addEventListener('click', () => {
              const text = messageInput.value.trim();
              if (text) {
                fetch('/message', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ text })
                });
                messageInput.value = '';
              }
            });
            
            // Allow Enter key to send
            messageInput.addEventListener('keydown', (e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendButton.click();
              }
            });
            
            // Clear conversation
            clearButton.addEventListener('click', () => {
              fetch('/conversation', {
                method: 'DELETE'
              });
              messagesDiv.innerHTML = '';
            });
            
            // Load current conversation on page load
            fetch('/conversation')
              .then(res => res.json())
              .then(data => {
                if (data.messages) {
                  data.messages.forEach(msg => {
                    const messageDiv = document.createElement('div');
                    messageDiv.classList.add('message');
                    messageDiv.classList.add(msg.role);
                    
                    messageDiv.textContent = \`\${msg.role === 'user' ? 'You' : 'Assistant'}: \${
                      msg.role === 'user' ? msg.content : (msg.text || msg.content || '')
                    }\`;
                    
                    messagesDiv.appendChild(messageDiv);
                  });
                  messagesDiv.scrollTop = messagesDiv.scrollHeight;
                }
              })
              .catch(() => {
                // Nothing to load
              });
          </script>
        </body>
        </html>
      `)
		})
	}

	private setupWebSocket() {
		this.wss.on("connection", (socket: any) => {
			// Use 'any' type for WebSocket to avoid TypeScript errors
			this.log("New WebSocket connection established")
			this.activeConnections.add(socket)

			// Clean up on connection close
			socket.on("close", () => {
				this.activeConnections.delete(socket)
				this.log("WebSocket connection closed")
			})

			// Listen for messages from clients
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

					if (data.type === "message" && data.text) {
						// Send message to the AI
						if (!this.provider.getCurrentCline()) {
							await this.provider.initClineWithTask(data.text, data.images)
						} else {
							await this.api.sendMessage(data.text, data.images)
						}
					}
				} catch (err) {
					this.log(`Error processing WebSocket message: ${err instanceof Error ? err.message : String(err)}`)
				}
			})
		})

		// Register message listener on the API to forward messages to WebSocket clients
		this.registerMessageListener()
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
			// Listen for messages from the Cline
			cline.on("message", (message: any) => {
				this.broadcastClineMessage(message.message)
			})

			// Listen for ask events (tool approvals)
			cline.on("ask", (askMessage: any) => {
				if (askMessage.ask.tool) {
					const toolMessage = {
						type: "tool_approval_required",
						id: Date.now().toString(),
						tool: askMessage.ask.tool,
						details: JSON.stringify(askMessage.ask, null, 2),
					}

					this.broadcast(toolMessage)
				}
			})
		})
	}

	/**
	 * Broadcast a Cline message to all connected WebSocket clients
	 */
	private broadcastClineMessage(message: ClineMessage) {
		// Ignore partial messages
		if (message.partial) {
			return
		}

		// Create a properly typed message format
		// Cast message to any to extract properties that might not be in the type definition
		const msg = message as any

		// Format the message for the WebSocket clients
		const formattedMessage = {
			type: "message",
			role: msg.role || (msg.type === "say" ? "assistant" : "user"),
			text: msg.text || msg.content || "",
			tool: msg.tool || null,
		}

		this.broadcast(formattedMessage)
	}

	/**
	 * Broadcast a message to all connected WebSocket clients
	 */
	private broadcast(message: any) {
		const messageStr = JSON.stringify(message)
		for (const client of this.activeConnections) {
			if (client.readyState === WS_OPEN) {
				client.send(messageStr)
			}
		}
	}

	/**
	 * Log a message to the output channel
	 */
	private log(message: string) {
		this.outputChannel.appendLine(`[RemoteServer] ${message}`)
	}
}
