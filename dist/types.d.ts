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
    /** QQ 消息白名单：c2c 用户 openid。配置后仅处理白名单内的私聊消息；未配置则放行全部（日志告警） */
    allowedUsers?: string[];
    /** QQ 消息白名单：群 openid。配置后仅处理白名单内的群消息；未配置则放行全部 */
    allowedGroups?: string[];
}
export type QBRole = "leader" | "follower";
export interface InstanceEntry {
    id: string;
    pid: number;
    role: QBRole;
    /** pi session 名（仅作为用户参考展示，不参与区分/路由；区分实例统一用 id） */
    name?: string;
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
    /** 消息内容类型: 0=文本, 3=卡片, 101=并行, 102=聊天记录, 103=引用消息 */
    message_type?: number;
    /** 消息场景上下文：ext 为 key=value 数组，含 msg_idx / ref_msg_idx=REFIDX_xxx */
    message_scene?: {
        source?: string;
        ext?: string[];
    };
    /** 引用消息时包含被引用内容（[0] 为被引用的原始消息） */
    msg_elements?: {
        msg_idx?: string;
        content?: string;
        message_type?: number;
        author?: {
            id?: string;
            bot?: boolean;
        };
    }[];
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
    /** 扩展信息。ref_idx 为引用消息索引，对应后续引用该消息事件的 ref_msg_idx */
    ext_info?: {
        ref_idx?: string;
    };
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
    /** 消息内容类型: 103=引用消息 */
    messageType?: number;
    /** 被引用消息索引（REFIDX_xxx），引用消息时从 message_scene.ext 的 ref_msg_idx 解析 */
    refMsgIdx?: string;
    /** 被引用消息内容（msg_elements[0].content），用于署名兜底路由 */
    refMsgContent?: string;
    /** 被引用消息是否为机器人所发（msg_elements[0].author.bot，QQ 未返回时为空） */
    refMsgFromBot?: boolean;
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
    /** 强制刷新 token（忽略本地缓存），用于 API 返回 401 后重试 */
    forceRefresh(): Promise<string>;
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
