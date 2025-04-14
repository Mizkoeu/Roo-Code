# Remote Control for Roo Code

This documentation explains how to use the newly added remote control functionality in Roo Code extension, allowing you to interact with the extension from your mobile device or any other computer.

## Overview

The remote control feature adds a web server to the Roo Code extension that:

1. Serves a simple web interface accessible from any browser
2. Provides REST API endpoints for programmatic interaction
3. Uses WebSockets for real-time streaming of AI responses and tool usage approvals

## Installation

1. Add the required dependencies to the extension:

```bash
npm install express ws
npm install --save-dev @types/express @types/ws
```

2. Restart VS Code to activate the extension with the new dependencies

## How It Works

When Roo Code extension is activated, it automatically starts a web server on port 9876 (configurable). This server:

- Serves a web UI accessible via browser at `http://localhost:9876/`
- Exposes API endpoints at paths like `/message`, `/conversation`, etc.
- Provides a WebSocket endpoint at `ws://localhost:9876/ws` for real-time communication

## Using from Your iPhone

1. **Connect to the Same Network**: Ensure your computer and iPhone are on the same WiFi network

2. **Find Your Computer's IP Address**:

    - On macOS: Open System Preferences > Network > WiFi and look for the IP address
    - On Windows: Open Command Prompt and type `ipconfig`, look for "IPv4 Address"

3. **Access the Web Interface**:

    - Open Safari on your iPhone
    - Navigate to `http://[YOUR-COMPUTER-IP]:9876`
    - Example: `http://192.168.1.100:9876`

4. **Use the Interface**:
    - Type messages in the text field to send to Roo Code
    - View responses in real-time
    - Approve or deny tool usage requests when they appear

## Building a Custom Mobile App

If you want to build a custom mobile app instead of using the web interface:

1. Use the documented REST API endpoints to communicate with Roo Code
2. Connect to the WebSocket endpoint for real-time updates
3. Use native UI components to create a more seamless experience

The API documentation can be found in `src/services/remote/README.md`.

## Security Considerations

This implementation doesn't include authentication or encryption. It's intended for use on trusted local networks only. Do not expose this server to the public internet.

## Troubleshooting

### Server Doesn't Start

- Check if another application is using port 9876
- Set a different port using the `ROO_CODE_REMOTE_PORT` environment variable in a `.env` file

### Can't Connect from Mobile Device

- Verify that your computer and mobile device are on the same network
- Check if your computer's firewall is blocking the connection
- Try disabling the firewall temporarily for testing

### Connection Issues

- Make sure VS Code is running with the Roo Code extension activated
- Check VS Code's output console for any error messages related to the remote server
- Restart VS Code and try again

## Implementation Details

The remote control functionality is implemented in:

- `src/services/remote/RemoteServer.ts`: Main server implementation
- `src/extension.ts`: Modified to initialize and start the server

## Customizing

To customize the web interface, modify the HTML in the `this.app.get('/', ...)` handler in `RemoteServer.ts`.
