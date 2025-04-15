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

- **WebSocket for Real-time Communication**: Uses WebSockets for bidirectional, real-time communication between the extension and remote clients with message types:

    - send_message - Send user messages to AI
    - new_conversation - Start new conversations
    - switch_mode - Change the active mode
    - set_model - Change the active LLM model
    - tool_response - Respond to tool usage requests
    - cancel_task - Cancel current task
    - human_relay_response - Handle relay responses
    - state_update - Update client state

- **Simple Web UI**: Provides a lightweight web interface accessible from any browser without requiring additional installations, served from the extension's webview-ui/build directory.

- **CORS Support**: Implements Cross-Origin Resource Sharing headers to allow cross-origin requests.

- **Express Middleware Pattern**: Uses Express.js middleware for request processing, static file serving, and API routing.

---

_File created during UMB process._
[2025-04-14 02:47:45] - Initial file creation.
[2025-04-14 20:18:55] - Documented system architectural patterns.
