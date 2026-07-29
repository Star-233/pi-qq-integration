import { createServer, connect, type Socket } from "node:net";
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { InstanceEntry, QBSession } from "./types.js";

export type IpcEnvelope =
	| { type: "register"; entry: InstanceEntry }
	| { type: "unregister" }
	| { type: "claim"; sessionKey: string }
	| { type: "outbound"; target: QBSession; content: string; replyTo?: { msgId?: string; eventId?: string } }
	| { type: "heartbeat" }
	| { type: "inbound"; session: QBSession; content: string; fromTag: "QQ" | "QQ群" };

export interface IpcServerOptions {
	onRegister?: (entry: InstanceEntry) => void;
	onClaim?: (sessionKey: string, instanceId: string) => void;
	onOutbound?: (msg: Extract<IpcEnvelope, { type: "outbound" }>, instanceId: string) => void;
	onDisconnect?: (instanceId: string) => void;
}

export function createIpcServer(sockPath: string, handlers: IpcServerOptions) {
	const dir = dirname(sockPath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	if (existsSync(sockPath)) {
		try {
			unlinkSync(sockPath);
		} catch {
			// 忽略
		}
	}

	const conns = new Map<string, Socket>();

	const server = createServer((sock) => {
		let buf = "";
		let id: string | null = null;
		sock.on("data", (data) => {
			buf += data.toString("utf-8");
			let idx: number;
			while ((idx = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, idx).trim();
				buf = buf.slice(idx + 1);
				if (!line) continue;
				try {
					const env = JSON.parse(line) as IpcEnvelope;
					if (env.type === "register") {
						id = env.entry.id;
						conns.set(id, sock);
						handlers.onRegister?.(env.entry);
					} else if (env.type === "claim" && id) {
						handlers.onClaim?.(env.sessionKey, id);
					} else if (env.type === "outbound" && id) {
						handlers.onOutbound?.(env, id);
					} else if (env.type === "heartbeat") {
						// no-op
					} else if (env.type === "unregister" && id) {
						conns.delete(id);
					}
				} catch {
					// 忽略坏行
				}
			}
		});
		sock.on("close", () => {
			if (id) {
				conns.delete(id);
				handlers.onDisconnect?.(id);
			}
		});
		sock.on("error", () => {
			// 忽略
		});
	});

	// Windows 上 IPC 必须用命名管道路径；listen 异步失败需向上冒泡（参见 ready Promise），
	// 否则无 'error' 监听时会升级为 uncaughtException 拖崩宿主进程。
	const ready = new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(sockPath, () => {
			server.on("error", () => { /* ignore post-listen errors */ });
			resolve();
		});
	});

	return {
		ready,
		sendTo(instanceId: string, env: IpcEnvelope): boolean {
			const sock = conns.get(instanceId);
			if (!sock) return false;
			try {
				sock.write(JSON.stringify(env) + "\n");
				return true;
			} catch {
				return false;
			}
		},
		has(instanceId: string): boolean {
			return conns.has(instanceId);
		},
		close() {
			try {
				server.close();
			} catch {
				// 忽略
			}
			try {
				if (existsSync(sockPath)) unlinkSync(sockPath);
			} catch {
				// 忽略
			}
		},
	};
}

export interface IpcClientOptions {
	onInbound?: (msg: Extract<IpcEnvelope, { type: "inbound" }>) => void;
	onConnect?: () => void;
	onClose?: () => void;
}

export function createIpcClient(sockPath: string, handlers: IpcClientOptions) {
	let sock: Socket | null = null;
	let buf = "";
	let connected = false;

	const client = connect(sockPath);
	sock = client;
	client.on("connect", () => {
		connected = true;
		handlers.onConnect?.();
	});
	client.on("data", (data) => {
		buf += data.toString("utf-8");
		let idx: number;
		while ((idx = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, idx).trim();
			buf = buf.slice(idx + 1);
			if (!line) continue;
			try {
				const env = JSON.parse(line) as IpcEnvelope;
				if (env.type === "inbound") handlers.onInbound?.(env);
			} catch {
				// 忽略坏行
			}
		}
	});
	client.on("close", () => {
		connected = false;
		handlers.onClose?.();
	});
	client.on("error", () => {
		connected = false;
		// 连接失败/异常：触发 onClose 让 follower 走重试逻辑，避免静默卡死
		handlers.onClose?.();
	});

	return {
		send(env: IpcEnvelope) {
			if (connected && sock) {
				try {
					sock.write(JSON.stringify(env) + "\n");
				} catch {
					// 忽略
				}
			}
		},
		isConnected() {
			return connected;
		},
		close() {
			try {
				sock?.destroy();
			} catch {
				// 忽略
			}
		},
	};
}
