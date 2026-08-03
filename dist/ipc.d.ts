import type { InstanceEntry, QBSession, QqSettings } from "./types.js";
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
    fromTag: string;
} | {
    type: "settings_request";
} | {
    type: "settings_update";
    settings: QqSettings;
} | {
    type: "settings_changed";
    settings: QqSettings;
} | {
    type: "instance_update";
    name: string;
} | {
    type: "reroute";
    sessionKey: string;
    targetId: string;
} | {
    type: "inject";
    session: QBSession;
    content: string;
};
export interface IpcServerOptions {
    onRegister?: (entry: InstanceEntry) => void;
    onClaim?: (sessionKey: string, instanceId: string) => void;
    onOutbound?: (msg: Extract<IpcEnvelope, {
        type: "outbound";
    }>, instanceId: string) => void;
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
export declare function createIpcServer(sockPath: string, handlers: IpcServerOptions): {
    ready: Promise<void>;
    sendTo(instanceId: string, env: IpcEnvelope): boolean;
    /** 向所有已连接的 follower 广播消息 */
    broadcast(env: IpcEnvelope): void;
    has(instanceId: string): boolean;
    followerIds(): string[];
    close(): void;
};
export interface IpcClientOptions {
    onInbound?: (msg: Extract<IpcEnvelope, {
        type: "inbound";
    }>) => void;
    /** leader 广播的 settings 变更 */
    onSettingsChanged?: (settings: QqSettings) => void;
    onConnect?: () => void;
    onClose?: () => void;
}
export declare function createIpcClient(sockPath: string, handlers: IpcClientOptions): {
    send(env: IpcEnvelope): void;
    isConnected(): boolean;
    close(): void;
};
