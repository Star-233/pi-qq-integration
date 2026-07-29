import type { InstanceEntry, QBSession } from "./types.js";
export type IpcEnvelope = {
    type: "register";
    entry: InstanceEntry;
} | {
    type: "unregister";
} | {
    type: "claim";
    sessionKey: string;
} | {
    type: "outbound";
    target: QBSession;
    content: string;
    replyTo?: {
        msgId?: string;
        eventId?: string;
    };
} | {
    type: "heartbeat";
} | {
    type: "inbound";
    session: QBSession;
    content: string;
    fromTag: "QQ" | "QQ群";
};
export interface IpcServerOptions {
    onRegister?: (entry: InstanceEntry) => void;
    onClaim?: (sessionKey: string, instanceId: string) => void;
    onOutbound?: (msg: Extract<IpcEnvelope, {
        type: "outbound";
    }>, instanceId: string) => void;
    onDisconnect?: (instanceId: string) => void;
}
export declare function createIpcServer(sockPath: string, handlers: IpcServerOptions): {
    sendTo(instanceId: string, env: IpcEnvelope): boolean;
    has(instanceId: string): boolean;
    close(): void;
};
export interface IpcClientOptions {
    onInbound?: (msg: Extract<IpcEnvelope, {
        type: "inbound";
    }>) => void;
    onConnect?: () => void;
    onClose?: () => void;
}
export declare function createIpcClient(sockPath: string, handlers: IpcClientOptions): {
    send(env: IpcEnvelope): void;
    isConnected(): boolean;
    close(): void;
};
