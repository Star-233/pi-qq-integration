import type { AuthManager, SendMessageRequest, SendMessageResponse, QBSession, QBSessionType } from "./types.js";
import { debug } from "./logger.js";

const API_BASE = "https://api.sgroup.qq.com";

/**
 * QQ Bot REST API 客户端。
 * 负责发送消息到 QQ。
 */
export function createApiClient(auth: AuthManager) {
  // 每个 msg_id 的回复序号，避免相同 msg_id + msg_seq 被去重
  const _msgSeqMap = new Map<string, number>();

  function nextMsgSeq(msgId: string): number {
    const next = (_msgSeqMap.get(msgId) ?? 0) + 1;
    _msgSeqMap.set(msgId, next);
    return next;
  }

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

    const json = (await resp.json().catch(() => ({}))) as SendMessageResponse;
    debug(`[QQ API] ${method} ${path} -> ${resp.status} ${JSON.stringify(json)}`);
    return json;
  }

  /**
   * 构建 Markdown 消息内容
   * @param text 原始文本（可能包含 Markdown 标记）
   */
  function buildMarkdownContent(text: string): { content: string } {
    return { content: text };
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
      content: text,
      msg_type: options?.msgType ?? 0, // 0=文本, 2=Markdown
    };

    if (options?.msgId) {
      body.msg_id = options.msgId;
      body.msg_seq = nextMsgSeq(options.msgId);
    }
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
    if (replyTo?.msgId) {
      body.msg_id = replyTo.msgId;
      body.msg_seq = nextMsgSeq(replyTo.msgId);
    }
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
      default:
        throw new Error(`不支持的会话类型: ${session.type}`);
    }

    return (await request("POST", path, body)) as SendMessageResponse;
  }

  return { sendMessage, sendText, sendMarkdown };
}

export type ApiClient = ReturnType<typeof createApiClient>;
