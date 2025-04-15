module.exports = {
	content: ["./src/**/*.{js,jsx,ts,tsx}"],
	theme: {
		extend: {
			colors: {
				"vscode-foreground": "var(--vscode-foreground)",
				"vscode-background": "var(--vscode-background)",
				"vscode-editor-background": "var(--vscode-editor-background)",
				"vscode-sideBar-background": "var(--vscode-sideBar-background)",
				"vscode-panel-border": "var(--vscode-panel-border)",
			},
		},
	},
	plugins: [],
}
