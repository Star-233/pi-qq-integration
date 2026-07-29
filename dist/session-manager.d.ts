import type { PiSessionInfo } from "./types.js";
export declare function createSessionManager(): {
    listSessions: () => PiSessionInfo[];
    getSessionPreview: (sessionName: string, maxMessages?: number) => string;
    formatSessionList: () => string;
};
export type SessionManager = ReturnType<typeof createSessionManager>;
