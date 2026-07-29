import type { AuthManager, SendMessageResponse, QBSession } from "./types.js";
export interface CreateApiClientOptions {
    initialMsgSeqMap?: Map<string, number>;
    onSeqUpdate?: (msgId: string, seq: number) => void;
}
/**
 * QQ Bot REST API 客户端。
 * 负责发送消息到 QQ。
 */
export declare function createApiClient(auth: AuthManager, options?: CreateApiClientOptions): {
    sendMessage: (session: QBSession, text: string, options?: {
        msgId?: string;
        eventId?: string;
        msgType?: number;
    }) => Promise<SendMessageResponse>;
    sendText: (session: QBSession, text: string, replyTo?: {
        msgId?: string;
        eventId?: string;
    }) => Promise<SendMessageResponse>;
    sendMarkdown: (session: QBSession, markdown: string, replyTo?: {
        msgId?: string;
        eventId?: string;
    }) => Promise<SendMessageResponse>;
};
export type ApiClient = ReturnType<typeof createApiClient>;
