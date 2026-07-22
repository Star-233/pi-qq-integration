// 轻量级类型声明：按需引用 Pi 扩展 API 中实际用到的类型
// 避免引入整个 @earendil-works/pi-coding-agent 包导致类型检查过慢

export interface ExtensionCommandContext {
	ui: {
		notify: (message: string, type?: "info" | "error" | "warning") => void;
	};
}

export interface ExtensionAPI {
	sendUserMessage: (text: string) => void;
	registerCommand: (
		name: string,
		info: {
			description: string;
			handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
		},
	) => void;
	on: <E = unknown>(event: string, handler: (event: E) => Promise<void> | void) => void;
}

export interface MessageEndEvent {
	message: {
		role: "user" | "assistant";
		content: string | Array<{ type?: string; text?: string }>;
	};
}

export interface ToolCallEvent {
	toolName: string;
	input: unknown;
}

export interface ToolResultEvent {
	content: string | Array<{ type?: string; text?: string }> | undefined;
}
