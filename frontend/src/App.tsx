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
}

interface ToolApprovalMessage {
	type: "tool_approval_required"
	id: string
	tool: string
	details: string
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

	// Refs
	const socketRef = useRef<WebSocket | null>(null)
	const messagesEndRef = useRef<HTMLDivElement>(null)

	// Connect to WebSocket
	useEffect(() => {
		const connectWebSocket = () => {
			const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
			const host = process.env.REACT_APP_API_HOST || window.location.hostname
			const port = process.env.REACT_APP_API_PORT || "9876"

			const socket = new WebSocket(`${protocol}//${host}:${port}/ws`)

			socket.onopen = () => {
				console.log("WebSocket connected")
				setIsConnected(true)
			}

			socket.onclose = () => {
				console.log("WebSocket disconnected")
				setIsConnected(false)
				// Try to reconnect after a delay
				setTimeout(connectWebSocket, 3000)
			}

			socket.onerror = (error) => {
				console.error("WebSocket error:", error)
			}

			socket.onmessage = (event) => {
				const data: WebSocketMessage = JSON.parse(event.data)
				console.log("Received message:", data)

				handleWebSocketMessage(data)
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
		switch (data.type) {
			case "cline_message":
				if (data.payload) {
					// Add the message to our state
					const incomingPayload = data.payload
					const isPartial = incomingPayload.partial === true
					const messageText = incomingPayload.text || incomingPayload.content || ""

					setMessages((prev) => {
						// Find the index of the last message with the same role (compatible way)
						const reversedIndex = prev
							.slice()
							.reverse()
							.findIndex((msg) => msg.role === incomingPayload.role)
						const lastMessageIndex = reversedIndex === -1 ? -1 : prev.length - 1 - reversedIndex

						if (
							isPartial &&
							lastMessageIndex !== -1 &&
							prev[lastMessageIndex].role === incomingPayload.role
						) {
							// Update the last message of the same role
							const updatedMessages = [...prev]
							updatedMessages[lastMessageIndex] = {
								...updatedMessages[lastMessageIndex], // Keep existing properties like ID if present
								...incomingPayload, // Overwrite with new payload data (like text)
								text: messageText,
								partial: true, // Ensure partial is true while streaming
							}
							return updatedMessages
						} else {
							// Add as a new message (either not partial, or first message from this role)
							const newMessage: ClineMessage = {
								...incomingPayload,
								text: messageText,
								partial: isPartial, // Set partial based on incoming data
								// Ensure essential fields are present
								type: incomingPayload.type || "unknown",
								role: incomingPayload.role || "assistant",
							}
							// If the *previous* message was partial and from the same role, mark it as complete now
							if (
								lastMessageIndex !== -1 &&
								prev[lastMessageIndex].partial &&
								prev[lastMessageIndex].role === newMessage.role
							) {
								const updatedMessages = [...prev]
								updatedMessages[lastMessageIndex].partial = false
								return [...updatedMessages, newMessage]
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
				setMessages((prev) => [
					...prev,
					{
						type: "tool_approval",
						text: `Tool approval required: ${toolApproval.tool}`,
						tool: toolApproval.tool,
						id: toolApproval.id,
						messageType: "tool_approval",
						role: "system",
					},
				])
				break

			case "state_update":
				if (data.payload) {
					console.log("Received state update:", data.payload)

					// Replace all messages with the new state if available
					if (data.payload.clineMessages) {
						setMessages(data.payload.clineMessages)
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
						},
					])
				}
				break
		} // End switch
	} // End handleWebSocketMessage
	// Auto-scroll to bottom when messages change
	useEffect(() => {
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
		if (!socketRef.current) return

		socketRef.current.send(
			JSON.stringify({
				type: "tool_response",
				payload: {
					approve,
					text,
				},
			}),
		)

		// Update the approval message in our local state
		setMessages((prev) =>
			prev.map((msg) =>
				msg.id === id
					? {
							...msg,
							text: approve ? "✓ Tool approved" : "✗ Tool denied",
							messageType: approve ? "approved" : "denied",
						}
					: msg,
			),
		)
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
						{/* Model Selector */}
						{/* Model Selector (uses currentModelId) */}
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
					{" "}
					{/* Added px-4 back */}
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
		if (message.messageType === "tool_approval") {
			return (
				<div className="approval">
					<div className="font-semibold mb-2">{message.text}</div>
					<div className="text-sm bg-gray-800 p-2 rounded mb-2 overflow-auto max-h-40 border border-gray-700">
						<div className="font-mono">{message.tool || "Unknown tool"}</div>
					</div>
					{onToolResponse && (
						<div className="flex gap-2">
							<button
								className="bg-green-600 hover:bg-green-700 text-white px-3 py-1 rounded"
								onClick={() => onToolResponse(message.id || "", true)}>
								Approve
							</button>
							<button
								className="bg-red-600 hover:bg-red-700 text-white px-3 py-1 rounded"
								onClick={() => onToolResponse(message.id || "", false)}>
								Deny
							</button>
						</div>
					)}
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
						<span className="text-yellow-500 font-semibold">⚙️ Tool:</span> {message.tool}
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
