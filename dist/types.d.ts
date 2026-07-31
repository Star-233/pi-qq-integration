/** qq-integration-config.json 格式 */
export interface QQBotConfig {
    appId: string;
    appSecret: string;
    settings?: QqSettings;
    /** 多实例：本实例唯一 ID（默认 hostname-pid） */
    instanceId?: string;
    /** 多实例：强制角色，默认 auto（由文件锁选举） */
    role?: "auto" | "leader" | "follower";
    /** 是否在 pi 启动时自动连接 QQ Bot，默认 true（设 false 需手动 /qq-connect） */
    autoConnect?: boolean;
}
export type QBRole = "leader" | "follower";
export interface InstanceEntry {
    id: string;
    pid: number;
    role: QBRole;
    piSession?: string;
    sockPath?: string;
    startedAt: number;
    heartbeatAt: number;
    claimedSessions: string[];
}
export interface QQRegistry {
    leader: string | null;
    leaderSock?: string;
    instances: Record<string, InstanceEntry>;
}
/** 锁文件内容 */
export interface LockFile {
    pid: number;
    startedAt: number;
    heartbeatAt: number;
}
export declare enum OpCode {
    Dispatch = 0,
    Heartbeat = 1,
    Identify = 2,
    Resume = 6,
    Reconnect = 7,
    InvalidSession = 9,
    Hello = 10,
    HeartbeatACK = 11
}
export interface WSPayload {
    op: OpCode;
    d?: unknown;
    s?: number;
    t?: string;
}
export interface HelloData {
    heartbeat_interval: number;
}
export interface IdentifyData {
    token: string;
    intents: number;
    shard: [number, number];
}
export interface ResumeData {
    token: string;
    session_id: string;
    seq: number;
}
export interface MessageCreateEvent {
    id: string;
    content: string;
    author: {
        id?: string;
        user_openid?: string;
        member_openid?: string;
        username?: string;
        bot?: boolean;
    };
    timestamp: string;
    channel_id?: string;
    guild_id?: string;
    group_openid?: string;
    group_id?: string;
}
export interface GroupAddRobotEvent {
    group_openid: string;
    timestamp: string;
}
export interface FriendAddEvent {
    user_openid: string;
    timestamp: string;
}
export interface ReadyData {
    version: number;
    session_id: string;
    user: {
        id: string;
        username: string;
        bot: boolean;
    };
    shard: [number, number];
}
export interface SendMessageRequest {
    content: string;
    msg_type: number;
    msg_id?: string;
    event_id?: string;
    msg_seq?: number;
    markdown?: {
        content: string;
    };
    keyboard?: unknown;
}
export interface SendMessageResponse {
    id: string;
    timestamp: string;
}
export type QBSessionType = "c2c" | "group" | "channel";
export interface QBSession {
    type: QBSessionType;
    id: string;
    name: string;
    userId?: string;
    msgId?: string;
    eventId?: string;
    lastMsgSeq?: number;
}
export interface QQMessage {
    id: string;
    content: string;
    session: QBSession;
    timestamp: string;
    eventId?: string;
}
export interface QqSettings {
    forwardDesktopMessages: boolean;
    forwardToolCalls: boolean;
    lastMessageOnly: boolean;
    defaultSession?: QBSession;
}
export declare const DEFAULT_QQ_SETTINGS: QqSettings;
export interface PiSessionInfo {
    name: string;
    rawName: string;
    projectDir: string;
    path: string;
    modifiedAt: Date;
    size: number;
}
export interface LockManager {
    acquire(): Promise<boolean>;
    release(): Promise<void>;
    heartbeat(): Promise<void>;
    isOwner(): boolean;
    startHeartbeat(intervalMs: number): void;
    stopHeartbeat(): void;
    getDiagnostics(): LockDiagnostics;
}
export interface LockDiagnostics {
    isOwner: boolean;
    lockPath: string;
    lockExists: boolean;
    currentPid: number | null;
    heartbeatActive: boolean;
}
export interface AccessTokenResult {
    access_token: string;
    expires_in: number;
}
export interface AuthManager {
    getToken(): Promise<string>;
    startRefresh(): void;
    stopRefresh(): void;
    getDiagnostics(): AuthDiagnostics;
    onFatalError(handler: (err: Error) => void): void;
}
export interface AuthDiagnostics {
    hasToken: boolean;
    expiresAt: number | null;
    expiresInMs: number | null;
    lastRefreshTime: number | null;
    consecutiveRefreshFailures: number;
}
