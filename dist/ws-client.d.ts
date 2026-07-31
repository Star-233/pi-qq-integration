import type { AuthManager } from "./types.js";
import { type QQMessage } from "./types.js";
export type MessageHandler = (msg: QQMessage) => void;
export type EventHandler = (event: string, data: unknown) => void;
export interface WsDiagnostics {
    connected: boolean;
    state: string;
    sessionId: string | null;
    sequenceNumber: number;
    heartbeatIntervalMs: number;
    lastHeartbeatAck: number | null;
    reconnectCount: number;
    uptimeMs: number | null;
}
export interface WsClientOptions {
    /** 鉴权失败（InvalidSession）时的回调 */
    onAuthFailed?: () => void;
}
export interface WsClient {
    connect(): Promise<void>;
    disconnect(): void;
    onMessage(handler: MessageHandler): void;
    onEvent(handler: EventHandler): void;
    getSessionId(): string | null;
    getDiagnostics(): WsDiagnostics;
}
/**
 * QQ Bot WebSocket 客户端。
 * 管理连接、鉴权、心跳、断线重连（Resume）。
 */
export declare function createWsClient(auth: AuthManager, options?: WsClientOptions): WsClient;
