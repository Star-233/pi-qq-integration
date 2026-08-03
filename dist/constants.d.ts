export declare const PATHS: {
    readonly DATA_DIR: string;
    readonly CONFIG: string;
    readonly LOCK: string;
    readonly LOG: string;
    readonly REGISTRY: string;
    readonly INSTANCE_SOCK_DIR: string;
    readonly SESSIONS: string;
};
export declare const ENDPOINTS: {
    readonly API_BASE: string;
    readonly GATEWAY: `${string}/gateway`;
    readonly TOKEN: string;
};
export declare const DEFAULTS: {
    readonly HEARTBEAT_INTERVAL_MS: 30000;
    readonly FOLLOWER_RETRY_MS: 2000;
    readonly WS_HEARTBEAT_MS: 45000;
    readonly WS_CONNECT_TIMEOUT_MS: 15000;
    readonly WS_RECONNECT_DELAY_MS: 1000;
    readonly WS_RECONNECT_FAIL_DELAY_MS: 5000;
    readonly TOKEN_REFRESH_MARGIN_MS: 60000;
    readonly TOKEN_REFRESH_MIN_MS: 30000;
    readonly LOG_MAX_SIZE: number;
    readonly LOG_MAX_BUFFER: 200;
    readonly INTENTS: number;
    readonly SESSION_LIST_LIMIT: 20;
    readonly HISTORY_DEFAULT: 5;
    readonly MSG_PREVIEW_LEN: 300;
    readonly CONTENT_PREVIEW_LEN: 100;
};
export declare const TAGS: {
    readonly C2C: "QQ";
    readonly GROUP: "QQ群";
};
export declare function sessionTag(type: string): string;
