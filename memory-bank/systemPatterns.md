# System Patterns

- **Client-Server Architecture**: The RemoteServer implements a client-server architecture where the VSCode extension acts as the server, and mobile browsers act as clients.

- **REST API Pattern**: Implementation follows standard REST principles for the HTTP API endpoints including:

    - GET /api/status - Server status and version
    - GET /api/conversation - Current conversation state
    - POST /api/message - Send messages to AI
    - POST /api/conversation - Start new conversations
    - DELETE /api/conversation - Clear current conversation
    - POST /api/tool-response - Respond to tool usage approvals
    - GET /api/config - Get configuration data
    - GET /api/profiles - Get available LLM profiles
    - GET /api/pending-approvals - Check for pending tool approval requests

- **WebSocket for Real-time Communication**: Uses WebSockets for bidirectional, real-time communication between the extension and remote clients with message types:

    - send_message - Send user messages to AI
    - new_conversation - Start new conversations
    - switch_mode - Change the active mode
    - set_model - Change the active LLM model
    - tool_response - Respond to tool usage requests
    - cancel_task - Cancel current task
    - human_relay_response - Handle relay responses
    - state_update - Update client state
    - cline_message - Stream AI responses
    - tool_approval_required - Request tool approval
    - mode_switched - Confirm mode change
    - model_switched - Confirm model change

- **Simple Web UI**: Provides a lightweight web interface accessible from any browser without requiring additional installations, served from the extension's webview-ui/build directory.

- **CORS Support**: Implements Cross-Origin Resource Sharing headers to allow cross-origin requests.

- **Express Middleware Pattern**: Uses Express.js middleware for request processing, static file serving, and API routing.

- **Automatic Action Approval Pattern**: Implements a dedicated button and API endpoint for checking and approving pending tool usage requests, with periodic polling to automatically detect and handle new approval requests as they arise.

- **Streaming Message Pattern**: Implements a partial message update system where messages are marked with a 'partial' flag during streaming and updated incrementally in the UI, providing real-time feedback during AI response generation.

- **React State Management Pattern**: Uses React hooks (useState, useEffect, useRef, useCallback) for managing component state, WebSocket connections, and UI updates in response to server events.

- **Message Coalescing Pattern**: Implements logic to coalesce partial message updates into a single message in the UI, updating the content incrementally as streaming data arrives rather than showing multiple separate messages.

- **Timestamp-Based Ordering**: Uses timestamps on all messages to ensure consistent ordering in the UI, particularly important for asynchronous operations like tool approvals and system notifications.

- **System Message Feedback Pattern**: Implements dedicated system messages for important state changes (mode switches, model changes, tool approvals) to provide clear visual feedback to users.

---

_File created during UMB process._
[2025-04-14 02:47:45] - Initial file creation.
[2025-04-14 20:18:55] - Documented system architectural patterns.
[2025-04-14 21:25:42] - Added automatic action approval pattern and API endpoint.
[2025-04-16 23:56:40] - Added new patterns for message streaming, React state management, and system feedback.
