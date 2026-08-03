import type { ApiClient } from "./api-client.js";
import type { SessionManager } from "./session-manager.js";
import type { InstanceEntry, QBSession, QqSettings } from "./types.js";
/**
 * QQ 消息中的命令处理器。
 * 解析 #cmd args 格式的命令并执行。
 */
export declare function createCommandHandler(api: ApiClient, sessionManager: SessionManager, callbacks: {
    sendUserMessage: (text: string) => void;
    getSettings: () => QqSettings;
    updateSettings: (update: Partial<QqSettings>) => void;
    claimSession?: (session: QBSession) => void;
    getInstanceList?: () => InstanceEntry[];
    resolveInstance?: (target: string) => InstanceEntry | null;
    rerouteTo?: (targetId: string, session: QBSession) => boolean;
    injectTo?: (targetId: string, session: QBSession, content: string) => void;
    getClaimer?: (session: QBSession) => InstanceEntry | null;
    getCurrentSessionFile?: () => string | null;
    getCwd?: () => string | null;
    spawnInstance?: (opts: {
        cwd: string;
        sessionPath?: string;
    }) => Promise<{
        ok: boolean;
        pid?: number;
        error?: string;
    }>;
    closeInstance?: (pid: number) => Promise<{
        ok: boolean;
        self?: boolean;
        error?: string;
    }>;
}): {
    tryHandle: (text: string, from: QBSession) => Promise<boolean>;
};
export type CommandHandler = ReturnType<typeof createCommandHandler>;
