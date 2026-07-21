import type { AuthManager, SendMessageRequest, SendMessageResponse, QBSession, QBSessionType } from "./types";
import { warn } from "./logger";

const API_BASE = "https://api.sgroup.qq.com";
const MAX_CONTENT_LENGTH = 1800;

/**
 * QQ Bot REST API 客户端。
 * 负责发送消息到 QQ。
 */
export function createApiClient(auth: AuthManager) {
  async function request(
    method: string,
    path: string,
    body?: unknown
  ): Promise<unknown> {
    const token = await auth.getToken();
    const resp = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `QQBot ${token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (resp.status === 401) {
      // Token 可能过期，强制刷新后重试一次
      const newToken = await auth.getToken();
      const retryResp = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `QQBot ${newToken}`,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!retryResp.ok) {
        const text = await retryResp.text();
        throw new Error(`API 请求失败 (${retryResp.status}): ${text}`);
      }
      return await retryResp.json();
    }

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`API 请求失败 (${resp.status}): ${text}`);
    }

    return (await resp.json().catch(() => ({}))) as SendMessageResponse;
  }

  /**
   * 构建 Markdown 消息内容
   * @param text 原始文本（可能包含 Markdown 标记）
   */
  function buildMarkdownContent(text: string): { content: string } {
    if (text.length > MAX_CONTENT_LENGTH) {
      warn(`Markdown 内容过长 (${text.length} > ${MAX_CONTENT_LENGTH})，已截断`);
    }
    return { content: text.slice(0, MAX_CONTENT_LENGTH) };
  }

  /**
   * 发送消息到指定会话
   */
  async function sendMessage(
    session: QBSession,
    text: string,
    options?: {
      msgId?: string;
      eventId?: string;
      msgType?: number;
    }
  ): Promise<SendMessageResponse> {
    const body: SendMessageRequest = {
      content: text.slice(0, MAX_CONTENT_LENGTH),
      msg_type: options?.msgType ?? 0, // 0=文本, 2=Markdown
    };

    if (options?.msgId) body.msg_id = options.msgId;
    if (options?.eventId) body.event_id = options.eventId;

    let path: string;

    switch (session.type) {
      case "c2c":
        path = `/v2/users/${session.id}/messages`;
        break;
      case "group":
        path = `/v2/groups/${session.id}/messages`;
        break;
      case "channel":
        path = `/channels/${session.id}/messages`;
        break;
      default:
        throw new Error(`不支持的会话类型: ${session}`);
    }

    return (await request("POST", path, body)) as SendMessageResponse;
  }

  /**
   * 发送纯文本消息
   */
  async function sendText(
    session: QBSession,
    text: string,
    replyTo?: { msgId?: string; eventId?: string }
  ): Promise<SendMessageResponse> {
    return await sendMessage(session, text, {
      msgType: 0,
      msgId: replyTo?.msgId,
      eventId: replyTo?.eventId,
    });
  }

  /**
   * 发送 Markdown 消息
   */
  async function sendMarkdown(
    session: QBSession,
    markdown: string,
    replyTo?: { msgId?: string; eventId?: string }
  ): Promise<SendMessageResponse> {
    const body: SendMessageRequest = {
      content: "",
      msg_type: 2,
      markdown: buildMarkdownContent(markdown),
    };
    if (replyTo?.msgId) body.msg_id = replyTo.msgId;
    if (replyTo?.eventId) body.event_id = replyTo.eventId;

    let path: string;
    switch (session.type) {
      case "c2c":
        path = `/v2/users/${session.id}/messages`;
        break;
      case "group":
        path = `/v2/groups/${session.id}/messages`;
        break;
      case "channel":
        path = `/channels/${session.id}/messages`;
        break;
    }

    return (await request("POST", path, body)) as SendMessageResponse;
  }

  return { sendMessage, sendText, sendMarkdown };
}

export type ApiClient = ReturnType<typeof createApiClient>;
