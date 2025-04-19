import React, { useState, useEffect, useRef, useCallback } from "react"
import { marked } from "marked"
import hljs from "highlight.js"
import "highlight.js/styles/atom-one-dark.css"
import "./App.css"

// --- Types ---
interface Mode {
	slug: string
	name: string
}

interface ApiConfiguration {
	model?: string
	// Add other configuration properties
}

interface ModelProfile {
	id: string // Represents the unique identifier for the model/profile
	name: string
}

interface ClineMessage {
	id?: string
	type: string
	role?: string
	text?: string
	content?: string
	tool?: string
	messageType?: string
	partial?: boolean
	// Additional properties the message might have after processing
	approved?: boolean
	denied?: boolean
	ts?: number // Timestamp for ordering messages
	say?: string // For system messages
	ask?: string // For ask messages
}

interface ToolApprovalMessage {
	type: "tool_approval_required"
	id: string
	tool: string
	details: string
	ts?: number // Add timestamp field
	partial?: boolean // Add partial field for streaming support
}

interface WebSocketMessage {
	type: string
	payload?: any
	role?: string
	text?: string
	messageType?: string
	tool?: string
}

interface Config {
	modes: Mode[]
	currentMode: string
	apiConfiguration: ApiConfiguration
	profiles?: ModelProfile[] // Optional: profiles might come from a different endpoint
}

// --- Components ---
const App: React.FC = () => {
	// State
	const [availableModels, setAvailableModels] = useState<ModelProfile[]>([])
	const [messages, setMessages] = useState<ClineMessage[]>([])
	const [inputValue, setInputValue] = useState("")
	const [isConnected, setIsConnected] = useState(false)
	const [isLoading, setIsLoading] = useState(false)
	const [modes, setModes] = useState<Mode[]>([])
	const [currentMode, setCurrentMode] = useState("")
	const [currentModelId, setCurrentModelId] = useState<string | undefined>(undefined) // Store the ID
	const [respondingToApproval, setRespondingToApproval] = useState<string | null>(null) // Track which approval ID is being responded to

	// Refs
	const socketRef = useRef<WebSocket | null>(null)
	const messagesEndRef = useRef<HTMLDivElement>(null)

	// Connect to WebSocket
	useEffect(() => {
		const connectWebSocket = () => {
			const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
			const host = process.env.REACT_APP_API_HOST || window.location.hostname
			const port = process.env.REACT_APP_API_PORT || "9876"

			const wsUrl = `${protocol}//${host}:${port}/ws`
			console.log("Connecting to WebSocket at:", wsUrl)

			const socket = new WebSocket(wsUrl)

			socket.onopen = () => {
				console.log("WebSocket connected successfully")
				setIsConnected(true)
			}

			socket.onclose = (event) => {
				console.log("WebSocket disconnected with code:", event.code, "reason:", event.reason)
				setIsConnected(false)
				// Try to reconnect after a delay
				setTimeout(connectWebSocket, 3000)
			}

			socket.onerror = (error) => {
				console.error("WebSocket error:", error)
			}

			socket.onmessage = (event) => {
				try {
					const data: WebSocketMessage = JSON.parse(event.data)
					handleWebSocketMessage(data)
				} catch (error) {
					console.error("Error handling WebSocket message:", error)
					console.error("Raw message data:", event.data)
				}
			}

			socketRef.current = socket

			return () => {
				socket.close()
			}
		}

		connectWebSocket()
		fetchConfig() // Fetch initial config including current model/mode
		fetchProfiles() // Fetch available models

		return () => {
			if (socketRef.current) {
				socketRef.current.close()
			}
		}
	}, [])

	// Fetch configuration
	const fetchConfig = async () => {
		try {
			const response = await fetch("/api/config")
			if (!response.ok) {
				throw new Error(`HTTP error! status: ${response.status}`)
			}
			const data: Config = await response.json()

			setModes(data.modes)
			setCurrentMode(data.currentMode)

			// Set the current model ID from the fetched config
			if (data.apiConfiguration?.model) {
				setCurrentModelId(data.apiConfiguration.model)
			} else {
				setCurrentModelId(undefined) // Ensure it's cleared if not present
			}
		} catch (error) {
			console.error("Error fetching config:", error)
		}
	}

	// Fetch available models/profiles
	const fetchProfiles = async () => {
		try {
			// TODO: Replace with actual API endpoint if different
			const response = await fetch("/api/profiles")
			if (!response.ok) {
				throw new Error(`HTTP error! status: ${response.status}`)
			}
			const data: ModelProfile[] = await response.json()
			setAvailableModels(data)

			// If currentModelId is not set after fetching config, maybe set a default?
			// It's generally better to rely on the config's value.
			// if (!currentModelId && data.length > 0) {
			//    setCurrentModelId(data[0].id);
			// }
		} catch (error) {
			console.error("Error fetching profiles:", error)
			// Provide default/fallback models ONLY if fetch fails
			setAvailableModels([
				{ id: "claude-3-opus-20240229", name: "Claude 3 Opus (Default)" },
				{ id: "claude-3-sonnet-20240229", name: "Claude 3 Sonnet (Default)" },
				{ id: "claude-3-haiku-20240307", name: "Claude 3 Haiku (Default)" },
				{ id: "gpt-4o", name: "GPT-4o (Default)" },
			])
			// If fetch fails and no model ID is set, maybe set a fallback ID?
			if (!currentModelId) {
				setCurrentModelId("claude-3-opus-20240229") // Example fallback
			}
		}
	}

	// Handle WebSocket messages
	const handleWebSocketMessage = (data: WebSocketMessage) => {
		console.log("Processing WebSocket message type:", data.type)

		switch (data.type) {
			case "cline_message":
				if (data.payload) {
					// Add the message to our state
					const incomingPayload = data.payload
					const isPartial = incomingPayload.partial === true
					const messageText = incomingPayload.text || incomingPayload.content || ""

					setMessages((prev) => {
						// Ensure incoming message has a timestamp
						if (!incomingPayload.ts) {
							incomingPayload.ts = Date.now()
						}

						// Find the index of the last message with the same role
						const reversedIndex = prev
							.slice()
							.reverse()
							.findIndex((msg) => msg.role === incomingPayload.role)
						const lastMessageIndex = reversedIndex === -1 ? -1 : prev.length - 1 - reversedIndex

						// Case 1: Update existing message if it's the same role and either:
						// - Current message is partial, or
						// - Previous message was partial and this one is not (completion of streaming)
						if (
							lastMessageIndex !== -1 &&
							prev[lastMessageIndex].role === incomingPayload.role &&
							(isPartial || prev[lastMessageIndex].partial === true)
						) {
							// Update the last message of the same role
							const updatedMessages = [...prev]
							updatedMessages[lastMessageIndex] = {
								...updatedMessages[lastMessageIndex], // Keep existing properties like ID
								...incomingPayload, // Overwrite with new payload data
								text: messageText,
								partial: isPartial, // Update partial flag based on incoming message
								// Preserve the original timestamp and role
								ts: updatedMessages[lastMessageIndex].ts,
								role: updatedMessages[lastMessageIndex].role || incomingPayload.role || "assistant",
							}
							return updatedMessages
						} else {
							// Add as a new message (different role or not a streaming situation)
							const newMessage: ClineMessage = {
								...incomingPayload,
								text: messageText,
								partial: isPartial,
								// Ensure essential fields are present
								type: incomingPayload.type || "unknown",
								role: incomingPayload.role || "assistant",
								ts: incomingPayload.ts || Date.now(),
							}
							return [...prev, newMessage]
						}
					})

					// Only stop loading if the message is NOT partial
					if (!isPartial) {
						setIsLoading(false)
					}

					// isLoading is now handled within the setMessages update logic based on partial status
				}
				break

			case "tool_approval_required":
				// Special handling for tool approvals
				const toolApproval = data as ToolApprovalMessage
				console.log("Received tool approval message:", toolApproval)

				// Check if the message is partial
				const isPartial = toolApproval.partial === true
				const messageText = toolApproval.details || ""

				setMessages((prev) => {
					// Ensure incoming message has a timestamp
					if (!toolApproval.ts) {
						toolApproval.ts = Date.now()
					}

					// Find the index of the last message with the same role
					const reversedIndex = prev
						.slice()
						.reverse()
						.findIndex((msg) => msg.type === toolApproval.type)
					const lastMessageIndex = reversedIndex === -1 ? -1 : prev.length - 1 - reversedIndex

					// If we found an existing message with the same ID and either:
					// - Current message is partial, or
					// - Previous message was partial and this one is not (completion of streaming)
					if (
						lastMessageIndex !== -1 &&
						prev[lastMessageIndex].type === toolApproval.type &&
						(isPartial || prev[lastMessageIndex].partial === true)
					) {
						// Update the existing message
						const updatedMessages = [...prev]
						updatedMessages[lastMessageIndex] = {
							...updatedMessages[lastMessageIndex], // Keep existing properties like ID
							text: messageText,
							tool: toolApproval.tool,
							partial: isPartial, // Update partial flag based on incoming message
							// Preserve the original timestamp
							ts: updatedMessages[lastMessageIndex].ts,
						}
						return updatedMessages
					} else {
						// Add as a new message (different ID or not a streaming situation)
						return [
							...prev,
							{
								type: "tool_approval_required",
								text: messageText,
								tool: toolApproval.tool,
								id: toolApproval.id,
								messageType: "tool_approval_required",
								role: "system",
								ts: toolApproval.ts || Date.now(),
								partial: isPartial,
							},
						]
					}
				})

				// Only stop loading if the message is NOT partial
				if (!isPartial) {
					setIsLoading(false)
				}
				break

			case "state_update":
				if (data.payload) {
					console.log("Received state update:", data.payload)

					// Replace all messages with the new state if available
					if (data.payload.clineMessages) {
						console.log("Updating messages from state update")

						// Process the messages to ensure roles are preserved
						const processedMessages = data.payload.clineMessages.map((msg: ClineMessage) => {
							// Ensure each message has a role based on its type/content
							if (!msg.role) {
								if (msg.type === "say") {
									switch (msg.say) {
										case "api_req_started":
										case "api_req_finished":
										case "api_req_retry_delayed":
										case "error":
										case "completion_result":
											msg.role = "system"
											break
										case "task":
											msg.role = "user"
											break
										default:
											msg.role = "assistant"
									}
								} else if (msg.type === "ask") {
									const askType = msg.ask
									if (
										askType === "tool" ||
										askType === "command" ||
										askType === "use_mcp_server" ||
										askType === "browser_action_launch"
									) {
										msg.role = "system"
									} else if (askType === "followup") {
										msg.role = "assistant"
									} else {
										msg.role = "user"
									}
								}
							}

							// Ensure timestamp exists
							if (!msg.ts) {
								msg.ts = Date.now()
							}

							return msg
						})

						// Don't sort messages - keep them in the original order from the server
						// The backend already sends them in chronological order

						setMessages(processedMessages)
					}

					// Always reset the respondingToApproval flag when we receive a state update
					// This ensures buttons will be responsive regardless of previous state
					console.log("Current respondingToApproval value:", respondingToApproval)
					if (respondingToApproval) {
						console.log("Resetting respondingToApproval flag after state update")
						setRespondingToApproval(null)
					}

					// Update current mode from state
					// Check both currentMode (frontend naming) and mode (backend naming)
					const newMode = data.payload.currentMode || data.payload.mode
					if (newMode && newMode !== currentMode) {
						console.log(`Mode updated from state: ${newMode} (was: ${currentMode})`)
						setCurrentMode(newMode)
					}

					// Update model ID from apiConfiguration
					// Check both direct model property and nested in apiConfiguration
					const newModelId =
						data.payload.model || (data.payload.apiConfiguration && data.payload.apiConfiguration.model)

					if (newModelId && newModelId !== currentModelId) {
						console.log(`Model updated from state: ${newModelId} (was: ${currentModelId || "undefined"})`)
						setCurrentModelId(newModelId)

						// Refresh available models list if needed
						if (availableModels.length === 0 || !availableModels.some((m) => m.id === newModelId)) {
							fetchProfiles()
						}
					} else if (newModelId === undefined && currentModelId !== undefined) {
						// Only clear if we're explicitly getting undefined (not just missing property)
						if (
							"model" in data.payload ||
							(data.payload.apiConfiguration && "model" in data.payload.apiConfiguration)
						) {
							setCurrentModelId(undefined)
						}
					}

					// Reset the respondingToApproval flag when we receive a state update
					// This allows the approval buttons to be used again for future tool approvals
					if (respondingToApproval) {
						console.log("Resetting respondingToApproval flag after state update")
						setRespondingToApproval(null)
					}

					setIsLoading(false)
				}
				break

			case "mode_switched": // Backend confirms mode switch
				if (data.payload?.mode) {
					// mode here is the slug
					setCurrentMode(data.payload.mode)

					// Add system message about mode change
					setMessages((prev) => [
						...prev,
						{
							type: "system",
							text: `Mode switched to ${data.payload.mode}`,
							role: "system",
							messageType: "system",
							ts: Date.now(), // Add timestamp for proper ordering
						},
					])
				}
				break
			// Add case for explicit model switch confirmation if backend sends it
			case "model_switched": // Now implemented in the server
				if (data.payload?.modelId) {
					setCurrentModelId(data.payload.modelId)
					console.log(`Model explicitly switched to: ${data.payload.modelId}`)

					// Add system message about model change
					const modelName = getDisplayNameForModel(data.payload.modelId)
					setMessages((prev) => [
						...prev,
						{
							type: "system",
							text: `Model switched to ${modelName}`,
							role: "system",
							messageType: "system",
							ts: Date.now(), // Add timestamp for proper ordering
						},
					])
				}
				break
		} // End switch
	} // End handleWebSocketMessage
	// Auto-scroll to bottom when messages change
	useEffect(() => {
		// Sort messages by timestamp to ensure correct order
		if (messages.length > 1) {
			// No need to sort - the backend already sends messages in chronological order
			// and we append new messages at the end of the array
		}

		scrollToBottom()
	}, [messages])

	const scrollToBottom = () => {
		messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
	}

	// Send a message to the server
	const sendMessage = useCallback(() => {
		if (!inputValue.trim() || !socketRef.current) return

		// Add the message to our local state
		setMessages((prev) => [
			...prev,
			{
				type: "say",
				role: "user",
				text: inputValue,
				messageType: "user",
				ts: Date.now(), // Add timestamp for proper ordering
			},
		])

		// Send via WebSocket
		socketRef.current.send(
			JSON.stringify({
				type: "send_message",
				payload: {
					text: inputValue,
				},
			}),
		)

		// Clear input and show loading state
		setInputValue("")
		setIsLoading(true)
	}, [inputValue])

	// Handle Enter key press
	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault()
			sendMessage()
		}
	}

	// Start a new conversation
	const startNewConversation = () => {
		if (!socketRef.current) return

		socketRef.current.send(
			JSON.stringify({
				type: "new_conversation",
			}),
		)

		// Clear messages locally
		setMessages([])
	}

	// Switch modes
	const handleModeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
		const newMode = e.target.value
		if (!socketRef.current || newMode === currentMode) return

		// Optimistic UI Update
		setCurrentMode(newMode)

		socketRef.current.send(
			JSON.stringify({
				type: "switch_mode",
				payload: {
					mode: newMode,
				},
			}),
		)
	}

	// Switch models (LLM Profiles)
	const handleModelChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
		const newModelId = e.target.value
		// Prevent sending if no change or socket unavailable
		if (!socketRef.current || newModelId === currentModelId || !newModelId) return

		// Optimistic UI Update
		setCurrentModelId(newModelId)

		console.log(`Attempting to switch model to ID: ${newModelId}`)
		socketRef.current.send(
			JSON.stringify({
				type: "set_model", // Message type handled by backend
				payload: {
					modelId: newModelId,
				},
			}),
		)
		// The actual state (including display name) should be updated
		// when the backend confirms via a 'state_update' or 'model_switched' message.
	}

	// Handle tool approval response
	const respondToToolApproval = (id: string, approve: boolean, text?: string) => {
		console.log("respondToToolApproval called with:", { id, approve, text })
		console.log("WebSocket ready state:", socketRef.current ? socketRef.current.readyState : "null")

		if (!socketRef.current) {
			console.error("WebSocket is not available!")
			return
		}

		// Check if WebSocket is in OPEN state
		if (socketRef.current.readyState !== WebSocket.OPEN) {
			console.error("WebSocket is not in OPEN state. Current state:", socketRef.current.readyState)
			return
		}

		try {
			// Set flag to indicate we are processing this specific approval
			console.log("Setting respondingToApproval to:", id)
			setRespondingToApproval(id)

			console.log(`Sending tool response for ID ${id}: ${approve ? "approve" : "reject"}`)

			// Extract tool information from the messages if available
			const pendingApprovalMsg = messages
				.slice()
				.reverse()
				.find((msg) => msg.messageType === "tool_approval" && !msg.approved && !msg.denied)

			// Try to parse tool info from text if it exists
			let toolInfo = {}
			if (pendingApprovalMsg?.text) {
				try {
					if (
						typeof pendingApprovalMsg.text === "string" &&
						pendingApprovalMsg.text.startsWith("{") &&
						pendingApprovalMsg.text.includes('"tool"')
					) {
						toolInfo = JSON.parse(pendingApprovalMsg.text)
						console.log("Extracted tool info from message:", toolInfo)
					}
				} catch (e) {
					console.error("Error parsing tool text:", e)
				}
			}

			const message = JSON.stringify({
				type: "tool_response",
				payload: {
					id, // Include the message ID in the payload
					approve,
					text,
					tool: pendingApprovalMsg?.tool || (toolInfo as any).tool,
					toolInfo, // Include the parsed tool info if available
				},
			})

			console.log("Sending WebSocket message:", message)
			socketRef.current.send(message)
			console.log("WebSocket message sent successfully")
		} catch (error) {
			console.error("Error in respondToToolApproval:", error)
		}

		// Update the approval message in our local state immediately
		setMessages((prev) => {
			console.log("Updating messages to mark approval/rejection")
			return prev.map((msg) =>
				msg.id === id
					? {
							...msg,
							text: approve ? "✓ Tool approved" : "✗ Tool denied",
							messageType: "tool_approval", // Keep the messageType consistent
							approved: approve, // Add a flag for approval state
							denied: !approve, // Add a flag for denial state
						}
					: msg,
			)
		})

		// Set a short timeout to reset the flag
		// This ensures buttons will be responsive for future approvals
		setTimeout(() => {
			console.log("Timeout: Resetting respondingToApproval flag")
			setRespondingToApproval(null)
		}, 1000) // 1 second timeout is enough
	}

	// Helper function to get a display name for a given model ID
	const getDisplayNameForModel = (modelId?: string): string => {
		if (!modelId) return "Select Model" // Default text if no ID

		// Find the profile in the fetched available models
		const profile = availableModels.find((m) => m.id === modelId)
		if (profile) return profile.name // Return name from fetched data

		// Fallback if modelId is somehow set but not in availableModels (e.g., during loading)
		// You could use a hardcoded map here, or just return the ID
		const fallbackMap: { [key: string]: string } = {
			"claude-3-opus-20240229": "Claude 3 Opus",
			"claude-3-sonnet-20240229": "Claude 3 Sonnet",
			"claude-3-haiku-20240307": "Claude 3 Haiku",
			"gpt-4o": "GPT-4o",
			// Add others if needed
		}
		return fallbackMap[modelId] || modelId // Return from map or the ID itself
	}

	return (
		<div className="flex flex-col h-full bg-gray-900 text-gray-200 overflow-hidden">
			{" "}
			{/* Changed h-screen to h-full */}
			{/* Header */}
			<header className="bg-gray-800 py-4 px-4 shadow-lg">
				<div className="container mx-auto flex flex-wrap justify-between items-center">
					{" "}
					{/* Added flex-wrap */}
					<h1 className="text-xl font-bold flex items-center gap-2">
						<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
							<path
								d="M12 2L20 7V17L12 22L4 17V7L12 2Z"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"></path>
							<path
								d="M12 22V16"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"></path>
							<path
								d="M20 7L12 12L4 7"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"></path>
							<path
								d="M4 17L12 12"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"></path>
							<path
								d="M20 17L12 12"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"></path>
						</svg>
						Roo Code
					</h1>
					<div className="flex items-center gap-2">
						{/* Removed "Check Pending" button */}

						{/* Model Selector */}
						<select
							className="bg-gray-700 text-gray-200 py-1 px-3 rounded text-sm border-gray-600 focus:outline-none mr-2"
							value={currentModelId || ""} // Bind value to the model ID state
							onChange={handleModelChange}
							disabled={availableModels.length === 0 || !isConnected} // Disable if no models or disconnected
						>
							{/* Standard placeholder */}
							<option value="" disabled>
								Select Model
							</option>
							{/* List ALL available models */}
							{availableModels.map((model) => (
								<option key={model.id} value={model.id}>
									{model.name}
								</option>
							))}
						</select>
						<select
							className="bg-gray-700 text-gray-200 py-1 px-3 rounded text-sm border-gray-600 focus:outline-none"
							value={currentMode}
							onChange={handleModeChange}>
							<option value="" disabled>
								Select Mode
							</option>
							{modes.map((mode) => (
								<option key={mode.slug} value={mode.slug}>
									{mode.name}
								</option>
							))}
						</select>
					</div>
				</div>
			</header>
			{/* Main chat area */}
			{/* Main chat area - Adjusted for fixed footer */}
			<main className="flex-grow flex flex-col overflow-hidden">
				{" "}
				{/* Removed px/py, added flex flex-col */}
				{/* Message List - Takes remaining space and scrolls */}
				<div className="flex-grow overflow-y-auto mb-4 space-y-4 px-4 py-2">
					{" "}
					{/* Added px/py here */}
					{messages.length === 0 ? (
						<div className="text-center text-gray-400 my-8">
							<p className="text-xl mb-2">Welcome to Roo Code</p>
							<p className="text-sm">
								Ask Roo to help with coding tasks, create a new project, debug issues, or explain
								concepts.
							</p>
						</div>
					) : (
						messages.map((message, index) => (
							<MessageComponent key={index} message={message} onToolResponse={respondToToolApproval} />
						))
					)}
					{isLoading && (
						<div className="flex items-center gap-2 text-gray-400 my-4">
							<span>Roo is thinking</span>
							<div className="typing-dots">
								<span></span>
								<span></span>
								<span></span>
							</div>
						</div>
					)}
					<div ref={messagesEndRef} />
				</div>
				{/* Input area - Rearranged */}
				<div className="flex-shrink-0 border-t border-gray-700 pt-4 pb-6 px-4">
					{/* Tool approval buttons above the input when needed */}
					{/* Find the *last* message that requires approval */}
					{(() => {
						const pendingApprovalMsg = messages
							.slice()
							.reverse()
							.find((msg) => msg.messageType === "tool_approval" && !msg.approved && !msg.denied)

						if (pendingApprovalMsg) {
							return (
								<div className="flex justify-center mb-4 bg-gray-800 p-3 rounded-lg border border-gray-600">
									<div className="flex flex-col items-center gap-2">
										<div className="text-center text-sm mb-1">
											Tool requires your approval:{" "}
											<span className="font-medium">
												{pendingApprovalMsg.tool || "Unknown tool"}
											</span>
										</div>
										<div className="flex gap-3">
											<button
												className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg"
												disabled={false} // Remove the disabled condition completely
												onClick={() => {
													console.log("APPROVE button clicked")
													console.log("pendingApprovalMsg:", pendingApprovalMsg)
													console.log("respondingToApproval:", respondingToApproval)

													// Generate a fallback ID if none exists
													let approvalId = pendingApprovalMsg.id

													// If no ID, try to extract tool info from text if it's a JSON string
													if (!approvalId && pendingApprovalMsg.text) {
														try {
															// Check if text is a JSON string with tool info
															if (
																typeof pendingApprovalMsg.text === "string" &&
																pendingApprovalMsg.text.startsWith("{") &&
																pendingApprovalMsg.text.includes('"tool"')
															) {
																const toolData = JSON.parse(pendingApprovalMsg.text)
																// Use the tool name in the ID if available
																if (toolData.tool) {
																	approvalId = `${toolData.tool}-${Date.now()}`
																}
															}
														} catch (e) {
															console.error("Error parsing tool text:", e)
														}
													}

													// Fallback if we still don't have an ID
													if (!approvalId) {
														approvalId = `approval-${Date.now()}`
													}

													console.log("Calling respondToToolApproval with ID:", approvalId)
													respondToToolApproval(approvalId, true)
												}}>
												Approve
											</button>
											<button
												className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg"
												disabled={false} // Remove the disabled condition completely
												onClick={() => {
													console.log("REJECT button clicked")
													console.log("pendingApprovalMsg:", pendingApprovalMsg)
													console.log("respondingToApproval:", respondingToApproval)

													// Generate a fallback ID if none exists
													let approvalId = pendingApprovalMsg.id

													// If no ID, try to extract tool info from text if it's a JSON string
													if (!approvalId && pendingApprovalMsg.text) {
														try {
															// Check if text is a JSON string with tool info
															if (
																typeof pendingApprovalMsg.text === "string" &&
																pendingApprovalMsg.text.startsWith("{") &&
																pendingApprovalMsg.text.includes('"tool"')
															) {
																const toolData = JSON.parse(pendingApprovalMsg.text)
																// Use the tool name in the ID if available
																if (toolData.tool) {
																	approvalId = `${toolData.tool}-${Date.now()}`
																}
															}
														} catch (e) {
															console.error("Error parsing tool text:", e)
														}
													}

													// Fallback if we still don't have an ID
													if (!approvalId) {
														approvalId = `approval-${Date.now()}`
													}

													console.log("Calling respondToToolApproval with ID:", approvalId)
													respondToToolApproval(approvalId, false)
												}}>
												Reject
											</button>
										</div>
									</div>
								</div>
							)
						}
						return null
					})()}

					{/* Regular input area */}
					<div className="flex gap-2 items-end">
						{/* Buttons on the left */}
						<button
							className="flex-shrink-0 text-sm text-blue-400 hover:text-blue-300 flex items-center gap-1 p-2 rounded-lg border border-gray-600 hover:bg-gray-700"
							onClick={startNewConversation}
							title="New Chat">
							<svg
								xmlns="http://www.w3.org/2000/svg"
								className="h-5 w-5"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor">
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth="2"
									d="M12 6v6m0 0v6m0-6h6m-6 0H6"
								/>
							</svg>
						</button>
						<button
							className="flex-shrink-0 bg-blue-600 hover:bg-blue-700 text-white rounded-lg px-4 py-2 font-medium focus:outline-none focus:ring-2 focus:ring-blue-500"
							onClick={sendMessage}
							disabled={!isConnected || !inputValue.trim()}
							title="Send Message">
							<svg
								xmlns="http://www.w3.org/2000/svg"
								className="h-5 w-5"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
								strokeWidth="2">
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
								/>
							</svg>
						</button>
						{/* Textarea takes remaining space */}
						<textarea
							className="flex-grow bg-gray-800 text-gray-200 rounded-lg border border-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 px-4 py-2 resize-none" // Adjusted padding
							placeholder="Type a message to Roo..."
							rows={2} // Start with 2 rows, can grow
							value={inputValue}
							onChange={(e) => setInputValue(e.target.value)}
							onKeyDown={handleKeyDown}
							style={{ minHeight: "44px", maxHeight: "200px" }} // Control min/max height
						/>
					</div>
					{/* Connection Status below */}
					<div className="mt-2 flex justify-end">
						<div className={`text-xs ${isConnected ? "text-green-400" : "text-red-400"}`}>
							{isConnected ? "● Connected" : "○ Disconnected"}
						</div>
					</div>
				</div>
			</main>
		</div>
	)
}

// Message display component
interface MessageProps {
	message: ClineMessage
	onToolResponse?: (id: string, approve: boolean, text?: string) => void
}

const MessageComponent: React.FC<MessageProps> = ({ message, onToolResponse }) => {
	const messageClass = `message ${message.role}`
	// State for API message expansion
	const [isApiMessageExpanded, setIsApiMessageExpanded] = useState(false)
	const [isSystemMessageExpanded, setIsSystemMessageExpanded] = useState(false) // State for system message expansion

	// For code syntax highlighting
	useEffect(() => {
		document.querySelectorAll("pre code").forEach((block) => {
			hljs.highlightElement(block as HTMLElement)
		})
	}, [message])

	// Determine badge color and text based on role and message type
	const getBadgeInfo = () => {
		if (message.role === "assistant") {
			return { text: "Assistant", bgColor: "bg-green-400", textColor: "text-green-400" }
		} else if (message.role === "user") {
			return { text: "You", bgColor: "bg-blue-400", textColor: "text-blue-400" }
		} else if (message.messageType === "api_req_started" || message.messageType === "api_req_finished") {
			return { text: "API Request", bgColor: "bg-purple-400", textColor: "text-purple-400" }
		} else if (message.messageType === "tool" || message.messageType === "tool_approval") {
			return { text: "Tool", bgColor: "bg-yellow-400", textColor: "text-yellow-400" }
		} else if (message.messageType === "error" || message.messageType === "api_req_failed") {
			return { text: "Error", bgColor: "bg-red-400", textColor: "text-red-400" }
		} else if (message.messageType === "completion_result") {
			return { text: "Completed", bgColor: "bg-green-500", textColor: "text-green-500" }
		} else {
			return { text: "System", bgColor: "bg-gray-400", textColor: "text-gray-400" }
		}
	}

	const renderContent = () => {
		// Special handling for tool approvals
		if (message.messageType === "tool_approval" || message.messageType === "tool_approval_required") {
			// Skip duplicate tool approval messages
			if (message.text && message.text.startsWith("Tool approval required:")) {
				return null
			}

			return (
				<div className="approval">
					{message.tool && (
						<div className="text-sm bg-gray-800 p-2 rounded mb-2 overflow-auto max-h-96 border border-gray-700">
							<pre className="font-mono whitespace-pre-wrap">
								{(() => {
									try {
										// Try to parse and pretty-print the JSON
										const toolObj = JSON.parse(message.text || "{}")
										return JSON.stringify(toolObj, null, 2)
									} catch (e) {
										// If it's not valid JSON, just return the raw string
										return message.text || message.tool || "Unknown tool"
									}
								})()}
							</pre>
						</div>
					)}
					{/*
					   Tool buttons now appear at the input area instead of in each message
					   This keeps the message as informational only
					*/}
					{message.approved && <div className="text-green-400 font-medium mt-2">✓ Tool approved</div>}
					{message.denied && <div className="text-red-400 font-medium mt-2">✗ Tool denied</div>}
				</div>
			)
		}

		// API request or other system message handling
		if (
			message.messageType === "api_req_started" ||
			message.messageType === "api_req_finished" ||
			message.messageType === "api_req_failed"
		) {
			// Using the component-level state for expanded/collapsed state

			return (
				<>
					<div
						className="flex items-center gap-2 mb-2 cursor-pointer"
						onClick={() => setIsApiMessageExpanded(!isApiMessageExpanded)}
						style={{ userSelect: "none" }}>
						{getRoleBadge()}
						<span className={`codicon codicon-chevron-${isApiMessageExpanded ? "up" : "down"}`}></span>
					</div>
					{isApiMessageExpanded && <div className="text-sm">{message.text}</div>}
				</>
			)
		}

		// Completion result
		if (message.messageType === "completion_result") {
			return (
				<>
					<div className="flex items-center gap-2 mb-2">{getRoleBadge()}</div>
					<div className="border-l-2 border-green-500 pl-2">
						<div dangerouslySetInnerHTML={{ __html: marked(message.text || "") }} />
					</div>
				</>
			)
		}

		// Handle System messages (collapsible, JSON or Markdown)
		if (message.role === "system") {
			let content
			try {
				const parsedJson = JSON.parse(message.text || "{}")
				if (typeof parsedJson === "object" && parsedJson !== null) {
					content = (
						<pre className="bg-gray-800 p-3 rounded border border-gray-700 overflow-auto text-sm whitespace-pre-wrap break-words">
							<code className="language-json">{JSON.stringify(parsedJson, null, 2)}</code>
						</pre>
					)
				} else {
					// Parsed but wasn't an object/array, treat as markdown
					content = <div dangerouslySetInnerHTML={{ __html: marked(message.text || "") }} />
				}
			} catch (e) {
				// Not valid JSON, render as markdown
				content = <div dangerouslySetInnerHTML={{ __html: marked(message.text || "") }} />
			}

			return (
				<>
					<div
						className="flex items-center gap-2 mb-2 cursor-pointer"
						onClick={() => setIsSystemMessageExpanded(!isSystemMessageExpanded)}
						style={{ userSelect: "none" }}>
						{getRoleBadge()}
						<span className={`codicon codicon-chevron-${isSystemMessageExpanded ? "up" : "down"}`}></span>
					</div>
					{isSystemMessageExpanded && content}
				</>
			)
		}

		// Attempt to render Assistant/Tool messages as JSON if applicable
		if (message.text && (message.role === "assistant" || message.messageType === "tool")) {
			try {
				const parsedJson = JSON.parse(message.text)
				// Check if it's an actual object or array (not just a string/number parsed as JSON)
				if (typeof parsedJson === "object" && parsedJson !== null) {
					return (
						<>
							<div className="flex items-center gap-2 mb-2">{getRoleBadge()}</div>
							<pre className="bg-gray-800 p-3 rounded border border-gray-700 overflow-auto text-sm whitespace-pre-wrap break-words">
								<code className="language-json">{JSON.stringify(parsedJson, null, 2)}</code>
							</pre>
						</>
					)
				}
			} catch (e) {
				// Not valid JSON, fall through to default rendering
			}
		}

		// Default rendering for regular messages (Markdown for assistant, plain text otherwise)
		// Skip rendering assistant messages with empty text and messageType "text"
		if (
			message.role === "assistant" &&
			message.messageType === "text" &&
			(!message.text || message.text.trim() === "")
		) {
			return null
		}

		return (
			<>
				<div className="flex items-center gap-2 mb-2">{getRoleBadge()}</div>

				{/* Message content */}
				{message.role === "assistant" ? (
					<div dangerouslySetInnerHTML={{ __html: marked(message.text || "") }} />
				) : (
					<div>{message.text}</div>
				)}

				{/* Tool indicator if present */}
				{message.tool && (
					<div className="tool mt-2">
						<span className="text-yellow-500 font-semibold">⚙️ Tool:</span>{" "}
						{(() => {
							try {
								// Try to parse the JSON and extract the tool name
								const toolObj = JSON.parse(message.tool)
								// Return the tool name if available, otherwise the first few characters
								return (
									toolObj.name ||
									toolObj.tool_name ||
									(typeof toolObj === "object"
										? Object.keys(toolObj)[0]
										: message.tool.substring(0, 30) + (message.tool.length > 30 ? "..." : ""))
								)
							} catch (e) {
								// If it's not valid JSON, just return the first part of the string
								return message.tool.substring(0, 30) + (message.tool.length > 30 ? "..." : "")
							}
						})()}
					</div>
				)}
			</>
		)
	}

	// Helper function for consistent badge rendering
	const getRoleBadge = () => {
		const { text, bgColor, textColor } = getBadgeInfo()
		return (
			<span className={`px-2 py-1 text-xs rounded bg-opacity-20 ${textColor} ${bgColor} font-medium`}>
				{text}
			</span>
		)
	}

	return <div className={messageClass}>{renderContent()}</div>
}

export default App
