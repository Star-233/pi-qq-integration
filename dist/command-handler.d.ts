import type { ApiClient } from "./api-client.js";
import type { SessionManager } from "./session-manager.js";
import type { InstanceEntry, QBSession, QqSettings } from "./types.js";
/**
 * QQ 消息中的命令处理器。
 * 解析 #cmd args 格式的命令并执行。
 */
export declare function createCommandHandler(api: ApiClient, sessionManager: SessionManager, callbacks: {
    sendUserMessage: (text: string) => void;
    switchSession: (name: string) => void;
    newSession: () => void;
    clearSession: () => void;
    getSettings: () => QqSettings;
    updateSettings: (update: Partial<QqSettings>) => void;
    claimSession?: (session: QBSession) => void;
    getInstanceList?: () => InstanceEntry[];
    resolveInstance?: (target: string) => InstanceEntry | null;
    rerouteTo?: (targetId: string, session: QBSession) => boolean;
    injectTo?: (targetId: string, session: QBSession, content: string) => void;
    getClaimer?: (session: QBSession) => InstanceEntry | null;
}): {
    tryHandle: (text: string, from: QBSession) => Promise<boolean>;
};
export type CommandHandler = ReturnType<typeof createCommandHandler>;
