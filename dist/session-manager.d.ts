import type { PiSessionInfo } from "./types.js";
export declare function createSessionManager(): {
    listSessions: (cwd?: string) => PiSessionInfo[];
    getSessionPreview: (sessionName: string, maxMessages?: number) => string;
    getSessionFilePreview: (filePath: string, maxMessages?: number) => string;
    formatSessionList: (cwd?: string) => string;
};
export type SessionManager = ReturnType<typeof createSessionManager>;
