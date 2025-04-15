# Roo Code Frontend

This is a React-based frontend application for interacting with the Roo Code extension via WebSockets. It provides a clean, user-friendly interface for sending messages, receiving responses, approving tool usage, and switching between different modes.

## Features

- Real-time chat interface with Roo Code AI
- Code highlighting for code blocks in messages
- Tool approval UI
- Mode switching (Code, Architect, Ask, Debug, Test)
- Model selection
- Mobile-responsive design
- WebSocket-based communication with backend

## Setup

1. Install dependencies:

```bash
npm install
```

2. Configure the backend connection:

By default, the frontend connects to the backend at `http://localhost:9876`. You can override this by setting environment variables:

```bash
# .env.local
REACT_APP_API_HOST=localhost
REACT_APP_API_PORT=9876
```

3. Start the development server:

```bash
npm start
```

4. Build for production:

```bash
npm run build
```

## Architecture

- **WebSocket Communication**: Real-time bidirectional communication with the Roo Code server
- **React Components**: Clean separation of UI components
- **Tailwind CSS**: Styling with utility classes
- **TypeScript**: Type-safe code

## Backend API Endpoints

The frontend communicates with the backend via both REST API endpoints and WebSocket:

### REST API

- `GET /api/config`: Get available modes and configuration
- `GET /api/conversation`: Get current conversation state
- `POST /api/message`: Send a message to Roo
- `DELETE /api/conversation`: Clear the current conversation
- `POST /api/tool-response`: Respond to tool approval requests

### WebSocket Messages

- `send_message`: Send a new message to Roo
- `new_conversation`: Start a new conversation
- `switch_mode`: Change the current mode
- `tool_response`: Respond to tool approval requests

## Connecting to VS Code Extension

This frontend is designed to communicate with the Roo Code VS Code extension's RemoteServer component. Make sure the extension is running and the server is started on port 9876 (or configured port).
