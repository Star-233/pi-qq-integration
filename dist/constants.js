import { homedir } from "node:os";
import { join } from "node:path";
// ── 路径 ──
const DATA_DIR = process.env.QQ_INTEGRATION_DATA_DIR ?? join(homedir(), ".pi", "agent");
export const PATHS = {
    DATA_DIR,
    CONFIG: join(DATA_DIR, "qq-integration-config.json"),
    LOCK: join(DATA_DIR, "qq-integration.lock"),
    LOG: join(DATA_DIR, "qq-integration.log"),
    REGISTRY: join(DATA_DIR, "qq-integration", "registry.json"),
    INSTANCE_SOCK_DIR: join(DATA_DIR, "qq-integration", "instances"),
    SESSIONS: join(DATA_DIR, "sessions"),
};
// ── API 端点 ──
const QQ_API_BASE = process.env.QQ_API_BASE ?? "https://api.sgroup.qq.com";
export const ENDPOINTS = {
    API_BASE: QQ_API_BASE,
    GATEWAY: `${QQ_API_BASE}/gateway`,
    TOKEN: process.env.QQ_TOKEN_API ??
        "https://bots.qq.com/app/getAppAccessToken",
};
// ── 默认超时 / 间隔 ──
export const DEFAULTS = {
    HEARTBEAT_INTERVAL_MS: 30_000,
    FOLLOWER_RETRY_MS: 2_000,
    WS_HEARTBEAT_MS: 45_000,
    WS_CONNECT_TIMEOUT_MS: 15_000,
    WS_RECONNECT_DELAY_MS: 1_000,
    WS_RECONNECT_FAIL_DELAY_MS: 5_000,
    TOKEN_REFRESH_MARGIN_MS: 60_000,
    TOKEN_REFRESH_MIN_MS: 30_000,
    LOG_MAX_SIZE: 5 * 1024 * 1024,
    LOG_MAX_BUFFER: 200,
    INTENTS: 1 << 25, // C2C + GROUP_AT + FRIEND_ADD + GROUP_ADD_ROBOT
    SESSION_LIST_LIMIT: 20,
    /** #sessions 分页：每页条数 */
    SESSION_PAGE_SIZE: 10,
    /** #create spawn 新实例后等待其注册到 registry 的超时（ms） */
    SPAWN_WAIT_MS: 15_000,
    /** #close 发送 SIGTERM 后等待进程退出的时长（ms），超时则 SIGKILL */
    INSTANCE_CLOSE_WAIT_MS: 5_000,
    HISTORY_DEFAULT: 5,
    MSG_PREVIEW_LEN: 300,
    CONTENT_PREVIEW_LEN: 100,
};
// ── 标签 ──
export const TAGS = {
    C2C: "QQ",
    GROUP: "QQ群",
};
export function sessionTag(type) {
    return type === "c2c" ? TAGS.C2C : TAGS.GROUP;
}
