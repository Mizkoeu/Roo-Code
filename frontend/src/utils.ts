import { ClineMessage } from "./types"

// Exported from RemoteServer.ts to avoid cross-directory imports
export function getRole(message: ClineMessage): string {
	let role: "system" | "assistant" | "user" | "checkpoint" | "api_request" | "tool"
	if (message.type === "say") {
		if (message.say?.startsWith("api_req")) {
			role = "api_request"
		} else if (message.say?.startsWith("tool")) {
			role = "tool"
		} else {
			switch (message.say) {
				case "checkpoint_saved":
					role = "checkpoint"
					break
				case "mistake_limit_reached":
				case "error":
				case "completion_result":
					role = "system"
					break
				case "task":
				case "text":
					role = "assistant"
					break
				default:
					role = "user"
			}
		}
	} else {
		if (message.ask?.startsWith("api_req")) {
			role = "api_request"
		} else if (message.ask?.startsWith("tool")) {
			role = "tool"
		} else {
			switch (message.ask) {
				case "mistake_limit_reached":
				case "completion_result":
				case "finishTask":
					role = "system"
					break
				case "followup":
					role = "assistant"
					break
				default:
					role = "system"
			}
		}
	}
	return role
}
