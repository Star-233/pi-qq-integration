import { createServer, connect, type Socket } from "node:net";
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { InstanceEntry, QBSession, QqSettings } from "./types.js";

/** 单行 IPC 消息最大字节数，超过即断开连接（防内存耗尽 DoS） */
const MAX_LINE_BYTES = 1024 * 1024;

export type IpcEnvelope =
	| { type: "register"; entry: InstanceEntry }
	| { type: "unregister" }
	| { type: "claim"; sessionKey: string }
	| { type: "outbound"; target: QBSession; content: string; replyTo?: { msgId?: string; eventId?: string } }
	| { type: "heartbeat" }
	| { type: "inbound"; session: QBSession; content: string; fromTag: string }
	// Settings 同步 IPC
	| { type: "settings_request" }
	| { type: "settings_update"; settings: QqSettings }
	| { type: "settings_changed"; settings: QqSettings }
	// 多实例定向（follower → leader）
	| { type: "instance_update"; name: string }
	| { type: "reroute"; sessionKey: string; targetId: string }
	| { type: "inject"; session: QBSession; content: string };

export interface IpcServerOptions {
	onRegister?: (entry: InstanceEntry) => void;
	onClaim?: (sessionKey: string, instanceId: string) => void;
	onOutbound?: (msg: Extract<IpcEnvelope, { type: "outbound" }>, instanceId: string) => void;
	onDisconnect?: (instanceId: string) => void;
	/** follower 请求当前 settings（leader 收到后应回复 settings_changed） */
	onSettingsRequest?: (instanceId: string) => void;
	/** leader 要求 follower 执行 settings 变更 */
	onSettingsUpdate?: (settings: QqSettings, instanceId: string) => void;
	/** follower 上报显示名变化 */
	onInstanceUpdate?: (name: string, instanceId: string) => void;
	/** follower 请求把会话认领转给另一实例（#to 切换） */
	onReroute?: (sessionKey: string, targetId: string, instanceId: string) => void;
	/** follower 请求把内容注入某会话（#to <目标> <内容>） */
	onInject?: (session: QBSession, content: string, instanceId: string) => void;
}

export function createIpcServer(sockPath: string, handlers: IpcServerOptions) {
	// Windows 命名管道是临时资源（server 关闭即消失），无需文件系统目录创建/清理；
	// 仅 Unix domain socket 需要 mkdir 目录 + unlink 残留 socket 文件。
	if (process.platform !== "win32") {
		const dir = dirname(sockPath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		if (existsSync(sockPath)) {
			try {
				unlinkSync(sockPath);
			} catch {
				// 忽略
			}
		}
	}

	const conns = new Map<string, Socket>();

	const server = createServer((sock) => {
		let buf = "";
		let id: string | null = null;
		sock.on("data", (data) => {
			buf += data.toString("utf-8");
			if (Buffer.byteLength(buf) > MAX_LINE_BYTES) {
				sock.destroy();
				return;
			}
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
						handlers.onDisconnect?.(id);
					} else if (env.type === "settings_request" && id) {
						handlers.onSettingsRequest?.(id);
					} else if (env.type === "settings_update" && id) {
						handlers.onSettingsUpdate?.(env.settings, id);
					} else if (env.type === "instance_update" && id) {
						handlers.onInstanceUpdate?.(env.name, id);
					} else if (env.type === "reroute" && id) {
						handlers.onReroute?.(env.sessionKey, env.targetId, id);
					} else if (env.type === "inject" && id) {
						handlers.onInject?.(env.session, env.content, id);
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

	// listen 异步失败以 'error' 事件触发，无监听会升级为 uncaughtException 拖崩宿主进程；
	// 用 ready Promise 让调用方 await，失败时能被现有 try/catch 接住并走 teardown。
	const ready = new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(sockPath, () => {
			server.on("error", () => { /* 吞掉监听成功后的连接级错误 */ });
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
		/** 向所有已连接的 follower 广播消息 */
		broadcast(env: IpcEnvelope): void {
			const data = JSON.stringify(env) + "\n";
			for (const sock of conns.values()) {
				try {
					sock.write(data);
				} catch {
					// 忽略单个写失败
				}
			}
		},
		has(instanceId: string): boolean {
			return conns.has(instanceId);
		},
		followerIds(): string[] {
			return [...conns.keys()];
		},
		close() {
			// 主动断开所有已有连接
			for (const sock of conns.values()) {
				try {
					sock.destroy();
				} catch {
					// 忽略
				}
			}
			conns.clear();
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
	/** leader 广播的 settings 变更 */
	onSettingsChanged?: (settings: QqSettings) => void;
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
		if (Buffer.byteLength(buf) > MAX_LINE_BYTES) {
			client.destroy();
			return;
		}
		let idx: number;
		while ((idx = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, idx).trim();
			buf = buf.slice(idx + 1);
			if (!line) continue;
			try {
				const env = JSON.parse(line) as IpcEnvelope;
				if (env.type === "inbound") handlers.onInbound?.(env);
				else if (env.type === "settings_changed") handlers.onSettingsChanged?.(env.settings);
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
