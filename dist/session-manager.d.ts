import type { PiSessionInfo } from "./types.js";
export declare function createSessionManager(): {
    listSessions: (cwd?: string) => PiSessionInfo[];
    getSessionPreview: (sessionName: string, maxMessages?: number) => string;
    getSessionFilePreview: (filePath: string, maxMessages?: number) => string;
    formatSessionList: (cwd?: string, currentFile?: string | null) => string;
    formatSessionListPage: (opts: {
        page: number;
        pageSize: number;
        currentFile?: string | null;
    }) => {
        text: string;
        total: number;
        totalPages: number;
    };
    getSessionCwd: (filePath: string) => string | undefined;
    unencodeProjectDir: (dirName: string) => string;
};
export type SessionManager = ReturnType<typeof createSessionManager>;
