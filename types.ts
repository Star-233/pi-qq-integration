/** qq-integration-config.json 格式 */
export interface QQBotConfig {
  appId: string;
  appSecret: string;
  settings?: QqSettings;
}

/** 锁文件内容 */
export interface LockFile {
  pid: number;
  startedAt: number;
  heartbeatAt: number;
}

// ── QQ Bot WebSocket Protocol ──

export enum OpCode {
  Dispatch = 0,
  Heartbeat = 1,
  Identify = 2,
  Resume = 6,
  Reconnect = 7,
  InvalidSession = 9,
  Hello = 10,
  HeartbeatACK = 11,
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

// ── QQ Bot Gateway Events ──

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
  user: { id: string; username: string; bot: boolean };
  shard: [number, number];
}

// ── QQ Bot REST API ──

export interface SendMessageRequest {
  content: string;
  msg_type: number;
  msg_id?: string;
  event_id?: string;
  msg_seq?: number;
  markdown?: { content: string };
  keyboard?: unknown;
}

export interface SendMessageResponse {
  id: string;
  timestamp: string;
}

// ── Internal ──

export type QBSessionType = "c2c" | "group" | "channel";

export interface QBSession {
  type: QBSessionType;
  id: string;          // openid / group_openid / channel_id
  name: string;        // display name
  userId?: string;     // for groups: the sender's member_openid (for reply context)
}

export interface QQMessage {
  id: string;
  content: string;
  session: QBSession;
  timestamp: string;
}

// ── QQ Bot 转发设置 ──

export interface QqSettings {
  forwardDesktopMessages: boolean;
  forwardToolCalls: boolean;
}

export const DEFAULT_QQ_SETTINGS: QqSettings = {
  forwardDesktopMessages: false,
  forwardToolCalls: false,
};


export interface PiSessionInfo {
  name: string;
  rawName: string;
  projectDir: string;
  path: string;
  modifiedAt: Date;
  size: number;
}

// ── Lock Manager ──

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

// ── Auth ──

export interface AccessTokenResult {
  access_token: string;
  expires_in: number;
}

export interface AuthManager {
  getToken(): Promise<string>;
  startRefresh(): void;
  stopRefresh(): void;
  getDiagnostics(): AuthDiagnostics;
}

export interface AuthDiagnostics {
  hasToken: boolean;
  expiresAt: number | null;
  expiresInMs: number | null;
  lastRefreshTime: number | null;
}
