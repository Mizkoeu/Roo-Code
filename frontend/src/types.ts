// Simplified version of the ClineMessage type for frontend use
// Based on the schema in src/schemas
export interface ClineMessage {
	type: string
	role?: string
	text?: string
	content?: string
	tool?: string
	partial?: boolean
	approved?: boolean
	denied?: boolean
	ts?: number
	say?: string
	ask?: string
}
