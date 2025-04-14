# Roo Code Remote API

This module provides a REST API and WebSocket server that allows you to remotely control and interact with the Roo Code extension from external devices (like mobile phones, tablets, or other computers).

## Setup

1. Install the required dependencies:

    ```bash
    npm install express ws
    npm install --save-dev @types/express @types/ws
    ```

2. Restart VS Code to activate the server

## Configuration

The Remote API server runs on port 9876 by default. You can change this by setting an environment variable:

- Create a `.env` file in the root directory (or edit the existing one)
- Add the following line: `ROO_CODE_REMOTE_PORT=12345` (replace 12345 with your desired port)

## Usage

Once the extension is active, the Remote API server will start automatically. You'll see a notification in VS Code showing the port number.

### Accessing the Web Interface

To access the simple web interface:

1. Find your computer's local IP address (e.g., 192.168.1.100)
2. Open a browser on your mobile device and go to `http://[YOUR-IP-ADDRESS]:9876`
3. You'll see a simple chat interface where you can send messages to Roo Code and receive responses

### API Endpoints

The following REST API endpoints are available:

#### GET /status

Returns the current status of the server and extension version.

```json
{
	"status": "ok",
	"version": "3.11.14"
}
```

#### GET /conversation

Returns the current conversation if one exists.

```json
{
	"taskId": "a1b2c3d4",
	"messages": [
		{
			"role": "user",
			"content": "Create a React component"
		},
		{
			"role": "assistant",
			"text": "Here's a React component...",
			"tool": null
		}
	]
}
```

#### POST /message

Sends a message to the AI in the current conversation or starts a new conversation if none exists.

Request body:

```json
{
	"text": "Your message here"
}
```

Response:

```json
{
	"status": "accepted"
}
```

#### POST /conversation

Starts a new conversation.

Request body:

```json
{
	"text": "Initial message",
	"images": ["base64 encoded image data"] // Optional
}
```

Response:

```json
{
	"taskId": "a1b2c3d4"
}
```

#### DELETE /conversation

Clears the current conversation.

Response:

```json
{
	"status": "success"
}
```

#### POST /tool-response

Responds to a tool usage approval request.

Request body:

```json
{
	"approve": true,
	"text": "Custom response if not approved" // Optional
}
```

Response:

```json
{
	"status": "success"
}
```

### WebSocket Interface

For real-time communication, you can connect to the WebSocket endpoint at `ws://[YOUR-IP-ADDRESS]:9876/ws`.

#### Messages Sent to the Client

1. Regular messages:

```json
{
	"type": "message",
	"role": "assistant",
	"text": "Message content here",
	"tool": null
}
```

2. Tool approval requests:

```json
{
	"type": "tool_approval_required",
	"id": "12345",
	"tool": "write_to_file",
	"details": "Details about the tool usage"
}
```

#### Messages Sent from the Client

```json
{
	"type": "message",
	"text": "User message here"
}
```

## Security Considerations

This server does not implement authentication or encryption. It is intended for use on trusted local networks only. Do not expose this server to the public internet.
