# Decision Log

- [2025-04-14 20:18:30] - **HTTP/WebSocket Dual Protocol**: Decided to implement both HTTP REST API and WebSocket interfaces to support different client needs - REST for stateless operations and WebSocket for real-time streaming.

- [2025-04-14 20:18:30] - **Port Selection**: Selected port 9876 for the remote server to minimize conflicts with other common services.

- [2025-04-14 20:18:30] - **Simple Web UI**: Implemented a basic web interface to enable immediate usability from mobile devices without requiring separate app installation.

- [2025-04-14 20:18:30] - **Future Authentication**: Identified the need for authentication but deferred implementation to a future update to prioritize core functionality.

- [2025-04-14 20:19:30] - **Dynamic Frontend Path Resolution**: Implemented multiple fallback paths for serving the frontend UI to handle different development and production scenarios:

    - Primary: webview-ui/build
    - Fallbacks: frontend/build, ../frontend/build
    - Minimal UI when no frontend build is found

- [2025-04-14 20:19:30] - **Local Network IP Detection**: Added automatic detection of local network IP addresses to display connection URLs to users, making it easier to connect from mobile devices on the same network.

- [2025-04-14 20:19:30] - **Error Handling Strategy**: Implemented comprehensive error handling throughout the server implementation with detailed logging to the VSCode output channel for debugging.

- [2025-04-14 20:19:30] - **Mode Switching Support**: Added support for switching between different Roo Code modes (code, architect, ask, etc.) via the remote interface to provide full functionality from mobile devices.

- [2025-04-14 21:24:17] - **Automatic Action Approval**: Implemented a dedicated button and API endpoint for approving actions requested by the Roo extension. This enhances user experience by providing a quick way to approve tool usage requests without having to navigate through conversation messages.

- [2025-04-16 23:55:45] - **Enhanced Model Switching**: Implemented explicit model switching functionality with confirmation messages to provide clear feedback when changing models. This includes updating the provider settings manager, context proxy, and broadcasting state updates to all connected clients.

- [2025-04-16 23:55:45] - **Message Streaming Architecture**: Adopted a partial message update system that allows for real-time streaming of AI responses. Messages are marked with a 'partial' flag during streaming and updated incrementally, providing a more responsive user experience.

- [2025-04-16 23:55:45] - **Timestamp-Based Message Ordering**: Added timestamp fields to all messages to ensure consistent ordering in the UI, particularly important when dealing with asynchronous operations like tool approvals and system messages.

- [2025-04-16 23:55:45] - **System Message Feedback**: Implemented system messages for important state changes (mode switches, model changes, tool approvals) to provide clear visual feedback to users about the results of their actions.

---

_File created during UMB process._
[2025-04-14 02:47:55] - Initial file creation.
