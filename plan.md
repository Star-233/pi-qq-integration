# QQ Bot pi 扩展设计方案

> 基于 Pi Extensions API v1 与 QQ Bot 官方 API v2

---

## 一、技术选型与架构

### 1.1 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 扩展框架 | pi Extension API (registerTool / ctx.ui / pi.on) | 原生支持，热重载，TUI 交互 |
| QQ API | 官方 Bot API v2 | go-cqhttp 已停维，官方 API 稳定且有 Markdown/富媒体支持 |
| 参数校验 | typebox | pi 内置支持，与 registerTool 深度集成 |
| HTTP 客户端 | Node.js 内置 fetch (undici) | Node 18+ 内置，零依赖 |
| WebSocket | Node.js ws 包 | 成熟稳定，断线重连支持完善 |
| 运行时 | TypeScript (jiti 加载) | 无需预编译，pi 原生支持 |

### 1.2 鉴权流程

```
┌──────────────┐     POST /app/getAppAccessToken     ┌──────────────┐
│  pi 扩展     │ ── { app_id, client_secret } ──→   │ QQ API Auth  │
│  auth.ts     │ ←─ { access_token, expires_in } ── │ 网关         │
│              │                                       │              │
│  ┌────────┐  │   定时刷新策略：                       │              │
│  │ Token  │  │   - 缓存 access_token + 过期时间戳     │              │
│  │ 缓存   │  │   - 提前 5 分钟自动刷新                │              │
│  └────────┘  │   - API 401 时立即刷新重试             │              │
└──────┬───────┘                                       └──────────────┘
       │
       │ 带上 Authorization: QQBot {access_token}
       ▼
┌──────────────┐
│ QQ Bot API   │  https://api.sgroup.qq.com
│ 业务层       │
└──────────────┘
```

### 1.3 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│  pi Agent (LLM)                                              │
│    ↓ 调用工具 (tool_call)    ↑ 返回结果 (ToolResult)          │
├─────────────────────────────────────────────────────────────┤
│  qq-integration 扩展                                          │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ 工具层 (tools/)                                        │   │
│  │  qq_select_session.ts    qq_get_messages.ts           │   │
│  │  qq_send_message.ts                                   │   │
│  └──────────────┬──────────────────┬────────────────────┘   │
│                 ↓                  ↓                         │
│  ┌─────────────────────────────┐  ┌──────────────────────┐  │
│  │ API 封装层 (api/)             │  │ 事件监听层            │  │
│  │  client.ts - HTTP/WS 统一    │  │  session_start      │  │
│  │  sessions.ts - 会话操作       │  │  → 连接 WebSocket   │  │
│  │  messages.ts - 消息收发       │  │  session_shutdown   │  │
│  └──────────────┬──────────────┘  │  → 断开 WebSocket   │  │
│                 ↓                 │  tool_call           │  │
│  ┌─────────────────────────────┐  │  → 前置鉴权检查      │  │
│  │ 鉴权层 auth.ts               │  └──────────────────────┘  │
│  │  - access_token 管理        │                              │
│  │  - 定时刷新 + 401 自动重试    │                              │
│  └─────────────────────────────┘                              │
│                                                              │
│  ┌──────────────────────────────────────────────┐            │
│  │ 状态管理                                       │            │
│  │  - authEntry: 持久化 token (pi.appendEntry)    │            │
│  │  - sessionCache: 内存中会话列表                 │            │
│  │  - currentSessionId: 当前选中会话 (details)    │            │
│  └──────────────────────────────────────────────┘            │
└─────────────────────────────────────────────────────────────┘
```

### 1.4 WebSocket 长连接生命周期

```
session_start
  │
  ▼
Auth 成功？───否──→ 等待用户在 pi 中配置 AppID/Secret
  │是
  ▼
GET /gateway → 获取 WSS URL
  │
  ▼
WebSocket 连接（OpCode 2 Identify）
  │
  ├── OpCode 0 Dispatch → 处理消息事件
  │   ├── C2C_MESSAGE_CREATE → 缓存到 C2C 会话消息缓冲区
  │   ├── GROUP_AT_MESSAGE_CREATE → 缓存到群会话消息缓冲区
  │   ├── AT_MESSAGE_CREATE → 缓存到频道会话消息缓冲区
  │   ├── GROUP_ADD_ROBOT → 添加到群会话列表
  │   └── FRIEND_ADD → 添加到好友会话列表
  │
  ├── OpCode 7 Reconnect → 立即重连
  ├── OpCode 9 Invalid Session → 重新 Identify
  └── OpCode 11 Heartbeat ACK → 健康检查通过
  │
  ▼
session_shutdown → 发送 OpCode 7 Close → 断开 WS

断线重连策略：
  - 指数退避：1s → 2s → 4s → 8s → 16s → 32s → 60s（上限）
  - Resume 模式：携带 session_id 恢复（OpCode 6）
  - Resume 失败回退：完整 Identify 重建
```

---

## 二、扩展文件结构

```
~/.pi/agent/extensions/qq-integration/
├── package.json              # 依赖声明（ws）
├── index.ts                  # 入口：导出工厂函数，注册所有工具和事件
├── auth.ts                   # 鉴权模块：access_token 获取/缓存/刷新
├── api/
│   ├── client.ts             # HTTP + WebSocket 客户端统一封装
│   ├── sessions.ts           # 会话列表获取与事件收集
│   └── messages.ts           # 消息发送与历史获取
├── tools/
│   ├── select-session.ts     # qq_select_session 工具
│   ├── get-messages.ts       # qq_get_messages 工具
│   └── send-message.ts       # qq_send_message 工具
└── types.ts                  # 类型定义
```

### package.json

```json
{
  "name": "qq-integration",
  "dependencies": {
    "ws": "^8.16.0"
  },
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

---

## 三、类型定义 (types.ts)

```typescript
// ========== QQ Bot API 类型 ==========

/** 认证响应 */
export interface QQBotToken {
  access_token: string;
  expires_in: number;  // 秒
}

/** 会话类型 */
export type SessionType = "guild_channel" | "group" | "c2c";

/** 统一会话标识 */
export interface QBSession {
  id: string;              // 唯一标识，格式: "guild:{guild_id}:{channel_id}" | "group:{openid}" | "c2c:{openid}"
  type: SessionType;
  name: string;            // 可读名称
  // 不同类型的不同标识
  guild_id?: string;
  channel_id?: string;
  group_openid?: string;
  user_openid?: string;
  // 最后活跃时间
  lastActive: number;
  // 消息缓存（仅内存，不持久化）
  messageCache: QBCachedMessage[];
}

/** 缓存的消息 */
export interface QBCachedMessage {
  id: string;
  content: string;
  author: string;
  timestamp: number;
  isSelf: boolean;  // 是否自己发送的
}

/** QQ 频道消息（历史 API 返回） */
export interface QQChannelMessage {
  id: string;
  content: string;
  author: { id: string; username: string };
  timestamp: string;
}

// ========== 扩展内部状态类型 ==========

/** 持久化的 auth 状态 */
export interface QBAuthState {
  appId: string;
  // 注意：client_secret 和 access_token 不持久化在 entry 中
  // 仅存储 appId 用于提示用户已配置
  configured: boolean;
}

/** WebSocket 分片标识（连接时使用） */
export interface WSIdentifyPayload {
  op: 2;
  d: {
    token: string;      // "QQBot xxx"
    intents: number;    // 订阅事件位
    shard?: [number, number];
  };
}

/** 工具执行返回的 details 中的完整 session 缓存 */
export interface SessionCacheDetails {
  sessions: Array<Omit<QBSession, "messageCache">>;
  currentSessionId: string | null;
}

// ========== 事件订阅 intents ==========
// GuildMessages = 1 << 25 (监听频道消息)
// GroupMessages = 1 << 25 (群消息)
// C2CMessages   = 1 << 25 (私聊消息)
// 实际按需组合
export const QQ_INTENTS = {
  GUILD_MESSAGES: 1 << 25,
  GROUP_MESSAGES: 1 << 25,
  C2C_MESSAGES: 1 << 25,
  PUBLIC_GUILD_MESSAGES: 1 << 25,
} as const;
```

---

## 四、注册的自定义工具

### 4.1 qq_select_session — 选择 QQ 会话

```typescript
pi.registerTool({
  name: "qq_select_session",
  label: "选择 QQ 会话",
  description: "列出并选择一个 QQ 会话（群聊/私聊/频道），用于后续的消息操作。"
    + "群聊和好友会话通过 WebSocket 事件被动收集，频道可通过 API 获取列表。",
  parameters: Type.Object({
    filter: Type.Optional(Type.String({
      description: "筛选关键词，匹配会话名称或 ID",
    })),
    type: Type.Optional(
      Type.Array(
        Type.Union([
          Type.Literal("guild_channel"),
          Type.Literal("group"),
          Type.Literal("c2c"),
        ])
      )
    ),
  }),

  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // 1. 从内存中获取当前会话列表
    const sessions = getSessionCache();

    // 2. 如果缓存为空，先尝试通过 API 获取频道列表
    if (sessions.length === 0) {
      await refreshGuildSessions();
    }

    // 3. 应用筛选
    let filtered = [...sessions];
    if (params.type) {
      filtered = filtered.filter(s => params.type!.includes(s.type));
    }
    if (params.filter) {
      const kw = params.filter!.toLowerCase();
      filtered = filtered.filter(s =>
        s.name.toLowerCase().includes(kw) || s.id.includes(kw)
      );
    }

    // 4. 无可用会话时给出安装引导提示
    if (filtered.length === 0) {
      ctx.ui.notify("暂无可用会话，请先在 QQ 中与 Bot 对话或添加 Bot 到群聊", "warning");
      return {
        content: [{
          type: "text",
          text: "暂无可用会话。群聊和好友会话需要先让 Bot 在 QQ 中收到消息后才会出现（通过 WebSocket 事件自动收集）。"
            + "请先在 QQ 中：\n"
            + "1. 向 Bot 发送一条私聊消息\n"
            + "2. 或添加 Bot 到群聊后在群中 @Bot 发送消息\n"
            + "频道列表可通过 API 获取（如果 Bot 已加入频道）。",
        }],
        details: { sessions: [], currentSessionId: null },
      };
    }

    // 5. 构建 UI 选择列表
    const labels = filtered.map(s => {
      const icon = s.type === "guild_channel" ? "📢" : s.type === "group" ? "👥" : "💬";
      return `${icon} [${s.type}] ${s.name} (${s.id})`;
    });

    // 6. 使用 ctx.ui.select() 让用户选择
    const choice = await ctx.ui.select("选择 QQ 会话:", labels, { signal });
    if (!choice) {
      return {
        content: [{ type: "text", text: "用户取消了会话选择" }],
        details: { sessions: [], currentSessionId: null },
      };
    }

    // 7. 解析选择的会话
    const index = labels.indexOf(choice);
    const selected = filtered[index];
    setCurrentSession(selected.id);

    ctx.ui.notify(`已选择会话: ${selected.name}`, "info");

    // 8. 返回结果（不含 messageCache 减少上下文量）
    return {
      content: [{
        type: "text",
        text: `已选择会话：${selected.name}\n类型：${selected.type}\nID：${selected.id}\n消息缓存：${selected.messageCache.length} 条`,
      }],
      details: {
        sessions: sessions.map(s => ({
          id: s.id, type: s.type, name: s.name,
          guild_id: s.guild_id, channel_id: s.channel_id,
          group_openid: s.group_openid, user_openid: s.user_openid,
          lastActive: s.lastActive,
        })),
        currentSessionId: selected.id,
      },
    };
  },
});
```

### 4.2 qq_get_messages — 获取消息历史

```typescript
pi.registerTool({
  name: "qq_get_messages",
  label: "获取 QQ 消息",
  description: "获取指定会话的消息历史。频道会话支持通过 API 获取历史消息，"
    + "群聊和 C2C 会话通过 WebSocket 实时缓存的消息提供。必须先通过 qq_select_session 选择会话。",
  parameters: Type.Object({
    limit: Type.Optional(Type.Integer({
      description: "获取消息条数，最多 100 条",
      default: 20,
      minimum: 1,
      maximum: 100,
    })),
    before: Type.Optional(Type.String({
      description: "锚定消息 ID，获取该消息之前的消息（仅频道场景支持）",
    })),
  }),

  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // 1. 前置检查：是否有当前会话
    const session = getCurrentSession();
    if (!session) {
      throw new Error("请先使用 qq_select_session 选择要查看的会话");
    }

    let messages: QBCachedMessage[] = [];

    if (session.type === "guild_channel" && session.channel_id) {
      // 2. 频道场景：调用历史消息 API
      const apiMessages = await getChannelMessages(
        session.channel_id,
        params.limit ?? 20,
        params.before
      );
      messages = apiMessages.map(m => ({
        id: m.id,
        content: m.content,
        author: m.author.username,
        timestamp: new Date(m.timestamp).getTime(),
        isSelf: false,
      }));
    } else {
      // 3. 群聊/C2C 场景：从内存缓存读取
      const cache = session.messageCache;
      const limit = params.limit ?? 20;
      messages = cache.slice(-limit).reverse();
      if (params.before) {
        const idx = cache.findIndex(m => m.id === params.before);
        if (idx !== -1) {
          messages = cache.slice(0, idx).slice(-limit).reverse();
        }
      }
    }

    if (messages.length === 0) {
      ctx.ui.notify("该会话暂无消息", "info");
      return {
        content: [{ type: "text", text: "该会话暂无可用消息。" }],
        details: { messages: [] },
      };
    }

    // 4. 格式化输出
    const formatted = messages.map(m => {
      const time = new Date(m.timestamp).toLocaleString("zh-CN");
      return `[${time}] ${m.author}: ${m.content}`;
    }).join("\n");

    // 5. 如果消息过多，用 onUpdate 流式通知进度
    if (messages.length > 50) {
      onUpdate?.({
        content: [{ type: "text", text: `正在加载 ${messages.length} 条消息...` }],
      });
    }

    ctx.ui.notify(`获取到 ${messages.length} 条消息`, "info");

    return {
      content: [{
        type: "text",
        text: `会话「${session.name}」的历史消息（共 ${messages.length} 条）：\n\n${formatted}`,
      }],
      details: { messages: messages.slice(0, 30) }, // details 只保留部分避免膨胀
    };
  },
});
```

### 4.3 qq_send_message — 发送消息

```typescript
pi.registerTool({
  name: "qq_send_message",
  label: "发送 QQ 消息",
  description: "向已选中的 QQ 会话发送文本消息。根据会话类型自动选择对应的 API 端点。"
    + "注意：主动消息有每月 4 条/用户或群的频率限制，被动回复（48h 内交互过的会话）限制较宽松。",
  parameters: Type.Object({
    content: Type.String({
      description: "要发送的消息内容（纯文本）",
      minLength: 1,
      maxLength: 2000,
    }),
    msg_type: Type.Optional(
      Type.Integer({
        description: "消息类型：0=文本, 2=Markdown, 7=富媒体",
        default: 0,
      })
    ),
    confirm_send: Type.Optional(Type.Boolean({
      description: "是否跳过用户确认直接发送（仅在 LLM 确认内容无误时使用）",
      default: false,
    })),
  }),

  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // 1. 前置检查
    const session = getCurrentSession();
    if (!session) {
      throw new Error("请先使用 qq_select_session 选择要发送到的会话");
    }

    // 2. 发送前用户确认（重要的保障机制）
    if (!params.confirm_send) {
      const ok = await ctx.ui.confirm(
        "确认发送",
        `将要向「${session.name}」发送以下消息：\n\n${params.content}`,
        { signal }
      );
      if (!ok) {
        ctx.ui.notify("消息发送已取消", "warning");
        return {
          content: [{ type: "text", text: "用户取消了消息发送" }],
          details: { sent: false },
        };
      }
    }

    // 3. 检查认证状态
    const token = getAccessToken();
    if (!token) {
      throw new Error("QQ Bot 未认证，请先在扩展中配置 AppID 和 ClientSecret");
    }

    // 4. 调用发送 API
    onUpdate?.({ content: [{ type: "text", text: "正在发送消息..." }] });

    try {
      const result = await sendMessage(session, params.content, params.msg_type ?? 0);

      // 5. 缓存到自己消息列表中
      cacheSelfMessage(session.id, params.content);

      ctx.ui.notify("消息发送成功", "info");

      return {
        content: [{
          type: "text",
          text: `消息已成功发送到会话「${session.name}」\n消息ID: ${result.id || "N/A"}`,
        }],
        details: { sent: true, messageId: result.id },
        usage: {
          input: 0,
          output: 1,
          cost: { total: 0 },
        },
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      // 如果是 401，触发 token 刷新后提示重试
      if (errorMsg.includes("401")) {
        await refreshToken();
        ctx.ui.notify("Token 已刷新，请重新发送", "warning");
      }

      throw new Error(`消息发送失败: ${errorMsg}`);
    }
  },
});
```

---

## 五、UI 交互设计

### 5.1 交互场景流程

```
用户启动 pi → 扩展自动认证（有缓存 token）或要求配置
             │
             ▼
用户/LLM 调用 qq_select_session
             │
             ▼
        ctx.ui.select() ──→ 展示所有可用会话列表
             │                 ├─ 📢 [guild_channel] 频道名称
             │                 ├─ 👥 [group] 群聊名称
             │                 └─ 💬 [c2c] 好友昵称
             │
       用户选择一项 ──→ ctx.ui.notify("已选择会话: XXX", "info")
             │
             ▼
用户/LLM 调用 qq_get_messages
             │
             ▼
       （频道）→ 通过 API 获取 → 返回格式化消息
       （群聊/C2C）→ 从内存缓存读取 → 返回格式化消息
             │
             ▼
用户/LLM 调用 qq_send_message
             │
       参数中有 content
             │
             ▼
   params.confirm_send=false
        ctx.ui.confirm() ──→ "将要向 XXX 发送：..." → 确认/取消
             │
             ▼
        调用 API 发送
   ctx.ui.notify("消息发送成功", "info") 或 throw Error
```

### 5.2 各 UI 方法使用场景

| 方法 | 使用场景 | 参数示例 |
|---|---|---|
| `ctx.ui.select()` | 选择会话、选择消息类型 | `select("选择 QQ 会话:", sessions, { signal })` |
| `ctx.ui.confirm()` | 发送前确认、删除缓存确认 | `confirm("确认发送", content)` |
| `ctx.ui.input()` | 手动输入 AppID/Secret、编辑消息内容 | `input("请输入 AppID:", undefined, { timeout })` |
| `ctx.ui.editor()` | 编辑长消息内容 | `editor("编辑消息:", initialText)` |
| `ctx.ui.notify()` | 操作状态通知、错误提示 | `notify("认证成功", "info")` / `notify("连接断开", "error")` |

### 5.3 超时与取消处理

所有对话框操作都通过 `signal` 与 Agent 取消信号关联：

```typescript
// 在 execute 中通过 signal 参数传入
const session = await ctx.ui.select("选择会话:", options, { signal });
if (!session) {
  // 用户取消或超时，优雅降级
  return { content: [{ type: "text", text: "操作已取消" }], ... };
}
```

---

## 六、事件监听

### 6.1 session_start / session_shutdown — WebSocket 生命周期

```typescript
let wsConnection: WebSocket | null = null;

pi.on("session_start", async (event, ctx) => {
  // 1. 从 session 中恢复持久状态
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === "qq-auth") {
      const auth = entry.data as QBAuthState;
      if (auth.configured) {
        // 尝试从环境变量读取 secret，或提示用户
        await initializeBot(ctx);
      }
    }
  }

  // 2. 如果已认证，启动 WebSocket
  if (isAuthenticated()) {
    startWebSocket(ctx);
    ctx.ui.setStatus("qq-bot", "QQ Bot: 已连接");
  } else {
    ctx.ui.setStatus("qq-bot", "QQ Bot: 未配置");
  }
});

pi.on("session_shutdown", async (event, ctx) => {
  // 关闭 WebSocket
  if (wsConnection) {
    wsConnection.close(1000, "Session shutdown");
    wsConnection = null;
  }
  ctx.ui.setStatus("qq-bot", undefined);
});
```

### 6.2 tool_call — 前置鉴权检查

```typescript
pi.on("tool_call", async (event, ctx) => {
  // 只拦截 qq_* 工具
  if (!event.toolName.startsWith("qq_")) return;

  // 检查是否已认证
  if (!isAuthenticated()) {
    return {
      block: true,
      reason: "QQ Bot 尚未配置认证信息。请先设置 AppID 和 ClientSecret。",
    };
  }

  // 检查 WebSocket 是否连接（发送/获取消息需要）
  if (event.toolName === "qq_send_message" || event.toolName === "qq_get_messages") {
    if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN) {
      // 自动重连尝试
      await startWebSocket(ctx);
      if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN) {
        return {
          block: true,
          reason: "QQ Bot WebSocket 未连接，无法发送或获取消息。请检查网络连接后重试。",
        };
      }
    }
  }
});
```

### 6.3 WebSocket 事件处理

```typescript
function handleWSEvent(event: WSMessage, ctx: ExtensionContext) {
  switch (event.t) {
    case "C2C_MESSAGE_CREATE": {
      // 私聊消息
      const { author, content, id, timestamp } = event.d;
      const openid = author.user_openid;
      // 更新或创建 C2C 会话
      upsertSession({
        id: `c2c:${openid}`,
        type: "c2c",
        name: openid,  // 无法获取昵称，用 openid 代替
        user_openid: openid,
        lastActive: Date.now(),
      });
      // 缓存消息
      cacheMessage(`c2c:${openid}`, {
        id, content, author: openid, timestamp, isSelf: false,
      });
      // pi 通知（开发调试用）
      ctx.ui.setStatus("qq-msg", `收到私聊消息`);
      break;
    }
    case "GROUP_AT_MESSAGE_CREATE": {
      // 群聊 @ 消息
      const { group_openid, content, id, timestamp, author } = event.d;
      upsertSession({
        id: `group:${group_openid}`,
        type: "group",
        name: `群聊 ${group_openid.slice(0, 8)}`,
        group_openid,
        lastActive: Date.now(),
      });
      cacheMessage(`group:${group_openid}`, {
        id, content, author: author?.member_openid || "unknown",
        timestamp, isSelf: false,
      });
      break;
    }
    case "GROUP_ADD_ROBOT": {
      // Bot 被添加进群，需要记录但无消息
      const { group_openid, timestamp } = event.d;
      upsertSession({
        id: `group:${group_openid}`,
        type: "group",
        name: `群聊 ${group_openid.slice(0, 8)}`,
        group_openid,
        lastActive: Date.now(),
      });
      ctx.ui.notify("Bot 已加入新群聊", "info");
      break;
    }
    case "FRIEND_ADD": {
      const { openid, timestamp } = event.d;
      upsertSession({
        id: `c2c:${openid}`,
        type: "c2c",
        name: `用户 ${openid.slice(0, 8)}`,
        user_openid: openid,
        lastActive: Date.now(),
      });
      ctx.ui.notify("Bot 添加了新好友", "info");
      break;
    }
    case "RESUMED":
      ctx.ui.notify("QQ Bot WebSocket 已恢复连接", "info");
      break;
    case "RECONNECT":
      ctx.ui.notify("QQ Bot 要求重连", "warning");
      wsConnection?.close(1000, "Reconnecting");
      break;
  }
}
```

---

## 七、状态管理

### 7.1 持久化状态（pi.appendEntry）

```typescript
// 认证成功后持久化配置状态
pi.on("session_shutdown", async (_event, ctx) => {
  // 不持久化 secret/token，只记录已配置
  pi.appendEntry("qq-auth", {
    appId: configuredAppId,
    configured: true,
  } satisfies QBAuthState);
});

// session_start 时恢复
pi.on("session_start", async (_event, ctx) => {
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === "qq-auth") {
      const auth = entry.data as QBAuthState;
      if (auth.configured) {
        // 尝试从安全存储恢复 token（见风险章节）
        await restoreAuth(auth.appId);
      }
    }
  }
});
```

### 7.2 内存状态

```typescript
// ====== 模块级全局状态（扩展单例） ======

/** 当前 access_token 及过期信息 */
let tokenState: {
  access_token: string;
  expiresAt: number;    // Date.now() + expires_in * 1000
} | null = null;

/** 所有已知会话（内存缓存） */
let sessions: Map<string, QBSession> = new Map();

/** 当前选中的会话 ID */
let currentSessionId: string | null = null;

/** WebSocket 连接实例 */
let ws: WebSocket | null = null;

/** Token 刷新定时器 */
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

/** 已配置的 AppID */
let configuredAppId: string = "";
```

### 7.3 状态的一致性与分支回退

利用 pi 的 session 分支机制恢复工具状态：

```typescript
pi.on("session_start", async (_event, ctx) => {
  // 从当前分支的所有 tool_result 中恢复最近的状态
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.role === "toolResult") {
      const details = entry.message.details as SessionCacheDetails | undefined;
      if (details?.sessions) {
        // 重建 sessions 缓存（不含 messageCache，保持轻量）
        sessions.clear();
        for (const s of details.sessions) {
          sessions.set(s.id, { ...s, messageCache: [] });
        }
      }
      if (details?.currentSessionId) {
        currentSessionId = details.currentSessionId;
      }
    }
  }
});
```

---

## 八、完整 index.ts 代码骨架

```typescript
/**
 * QQ Bot pi 扩展
 * 
 * 让用户通过 pi 与 QQ 好友、群聊和频道交互。
 * 依赖：ws (WebSocket 客户端)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import WebSocket from "ws";

// ====== 内部模块导入 ======
// 实际开发时拆分为独立文件，这里为展示完整骨架直接内联
// import { getAccessToken, initializeAuth, refreshToken, isAuthenticated } from "./auth";
// import { startWebSocket, stopWebSocket } from "./api/client";
// import { getChannelMessages, sendMessage } from "./api/messages";
// import { getSessionCache, getCurrentSession, setCurrentSession, upsertSession, cacheMessage, cacheSelfMessage } from "./api/sessions";

// ====== 全局状态 ======
let tokenState: { access_token: string; expiresAt: number } | null = null;
const sessions = new Map<string, QBSession>();
let currentSessionId: string | null = null;
let ws: WebSocket | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let configuredAppId = "";

// ====== 类型 ======
type SessionType = "guild_channel" | "group" | "c2c";

interface QBSession {
  id: string;
  type: SessionType;
  name: string;
  guild_id?: string;
  channel_id?: string;
  group_openid?: string;
  user_openid?: string;
  lastActive: number;
  messageCache: QBCachedMessage[];
}

interface QBCachedMessage {
  id: string;
  content: string;
  author: string;
  timestamp: number;
  isSelf: boolean;
}

interface QBAuthState {
  appId: string;
  configured: boolean;
}

// ====== 工具函数占位 ======
function getAccessToken() { return tokenState?.access_token ?? null; }
function isAuthenticated() { return tokenState !== null && Date.now() < tokenState.expiresAt; }
function getSessionCache(): QBSession[] { return Array.from(sessions.values()); }
function getCurrentSession(): QBSession | null { return currentSessionId ? sessions.get(currentSessionId) ?? null : null; }
function setCurrentSession(id: string | null) { currentSessionId = id; }

async function initializeAuth(appId: string, clientSecret: string): Promise<void> {
  // POST https://bots.qq.com/app/getAppAccessToken
  // 获取 access_token，设置过期时间和定时刷新
}

async function refreshToken(): Promise<void> {
  // 从安全存储读取 client_secret，重新获取 token
}

async function getChannelMessages(channelId: string, limit: number, before?: string) {
  // GET /channels/{channelId}/messages
  // 仅限频道文字子频道
}

async function sendMessage(session: QBSession, content: string, msgType: number) {
  // 根据 session.type 选择对应端点
  // - c2c: POST /v2/users/{openid}/messages
  // - group: POST /v2/groups/{group_openid}/messages
  // - guild_channel: POST /channels/{channel_id}/messages
}

function upsertSession(session: Omit<QBSession, "messageCache">) {
  const existing = sessions.get(session.id);
  if (existing) {
    existing.lastActive = session.lastActive;
    existing.name = session.name;
  } else {
    sessions.set(session.id, { ...session, messageCache: [] });
  }
}

function cacheMessage(sessionId: string, msg: QBCachedMessage) {
  const session = sessions.get(sessionId);
  if (session) {
    session.messageCache.push(msg);
    // 限制缓存大小（最多 500 条/会话）
    if (session.messageCache.length > 500) {
      session.messageCache.splice(0, session.messageCache.length - 500);
    }
  }
}

function cacheSelfMessage(sessionId: string, content: string) {
  cacheMessage(sessionId, {
    id: `self_${Date.now()}`,
    content,
    author: "Me",
    timestamp: Date.now(),
    isSelf: true,
  });
}

async function startWebSocket(ctx: any): Promise<void> {
  // 1. GET /gateway 获取 WSS URL
  // 2. new WebSocket(wssUrl)
  // 3. OpCode 2 Identify
  // 4. 设置心跳、重连逻辑
  // 5. 处理 OpCode 0 Dispatch 事件
}

function stopWebSocket() {
  if (ws) {
    ws.close(1000, "Extension shutdown");
    ws = null;
  }
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

// ====== 扩展入口 ======
export default function (pi: ExtensionAPI) {
  // ========== 事件监听 ==========

  pi.on("session_start", async (_event, ctx) => {
    // 恢复持久化状态
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === "qq-auth") {
        const auth = entry.data as QBAuthState;
        if (auth.configured) {
          configuredAppId = auth.appId;
          ctx.ui.setStatus("qq-bot", `QQ Bot: 已配置 (${auth.appId})`);
        }
      }
      // 从分支工具结果恢复 session 缓存
      if (entry.type === "message" && entry.message.role === "toolResult") {
        const details = entry.message.details as Record<string, unknown>;
        if (details?.sessions && Array.isArray(details.sessions)) {
          for (const s of details.sessions as Array<Omit<QBSession, "messageCache">>) {
            sessions.set(s.id, { ...s, messageCache: [] });
          }
        }
        if (details?.currentSessionId) {
          currentSessionId = details.currentSessionId as string;
        }
      }
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopWebSocket();
    ctx.ui.setStatus("qq-bot", undefined);
  });

  pi.on("tool_call", async (event, _ctx) => {
    if (!event.toolName.startsWith("qq_")) return;
    if (!isAuthenticated()) {
      return {
        block: true,
        reason: "QQ Bot 未认证。请先在终端执行 `/qq-config <AppID> <ClientSecret>` 配置认证信息。",
      };
    }
  });

  // ========== 注册命令（配置命令 NOT qq_ 前缀） ==========

  pi.registerCommand("qq-config", {
    description: "配置 QQ Bot 的 AppID 和 ClientSecret",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      if (parts.length < 2) {
        ctx.ui.notify("用法：/qq-config <AppID> <ClientSecret>", "error");
        return;
      }
      const [appId, clientSecret] = parts;
      try {
        await initializeAuth(appId, clientSecret);
        configuredAppId = appId;
        pi.appendEntry("qq-auth", { appId, configured: true } satisfies QBAuthState);
        ctx.ui.notify("QQ Bot 认证成功，正在启动 WebSocket 连接...", "info");
        await startWebSocket(ctx);
        ctx.ui.setStatus("qq-bot", `QQ Bot: 已连接 (${appId})`);
      } catch (err) {
        ctx.ui.notify(`认证失败: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  pi.registerCommand("qq-status", {
    description: "查看 QQ Bot 连接状态",
    handler: async (_args, ctx) => {
      const auth = isAuthenticated() ? "已认证" : "未认证";
      const wsStatus = ws?.readyState === WebSocket.OPEN ? "已连接" : "未连接";
      const sessionCount = sessions.size;
      const current = getCurrentSession();
      ctx.ui.notify(
        `QQ Bot: ${auth}, WebSocket: ${wsStatus}, 会话数: ${sessionCount}${current ? `, 当前会话: ${current.name}` : ""}`,
        "info"
      );
    },
  });

  // ========== 注册工具 ==========

  // --- qq_select_session ---
  pi.registerTool({
    name: "qq_select_session",
    label: "选择 QQ 会话",
    description: "列出并选择一个 QQ 会话（群聊/私聊/频道）。"
      + "群聊和好友通过 WebSocket 事件被动收集，频道可通过 API 获取列表。",
    parameters: Type.Object({
      filter: Type.Optional(Type.String({ description: "筛选关键词" })),
      type: Type.Optional(Type.Array(Type.Union([
        Type.Literal("guild_channel"),
        Type.Literal("group"),
        Type.Literal("c2c"),
      ]))),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      let list = getSessionCache();

      // 如果缓存为空，刷新频道列表
      if (list.length === 0 && isAuthenticated()) {
        try {
          // GET /users/@me/guilds → 获取频道列表
          // 然后对每个频道 GET /guilds/{guildId}/channels → 获取文字子频道
          // 简化处理，此处省略具体实现
          onUpdate?.({ content: [{ type: "text", text: "正在通过 API 获取频道列表..." }] });
        } catch (err) {
          ctx.ui.notify("获取频道列表失败", "warning");
        }
        list = getSessionCache();
      }

      // 筛选
      if (params.type) {
        list = list.filter(s => params.type!.includes(s.type));
      }
      if (params.filter) {
        const kw = params.filter.toLowerCase();
        list = list.filter(s => s.name.toLowerCase().includes(kw) || s.id.includes(kw));
      }

      if (list.length === 0) {
        ctx.ui.notify("暂无可用会话", "warning");
        return {
          content: [{ type: "text", text: "暂无可用会话。请先在 QQ 中与 Bot 对话或添加 Bot 到群聊。" }],
          details: { sessions: [], currentSessionId: null },
        };
      }

      // 构建选择列表
      const labels = list.map(s => {
        const icon = s.type === "guild_channel" ? "📢" : s.type === "group" ? "👥" : "💬";
        return `${icon} [${s.type}] ${s.name}`;
      });

      const choice = await ctx.ui.select("选择 QQ 会话:", labels, { signal });
      if (!choice) {
        return {
          content: [{ type: "text", text: "用户取消了会话选择" }],
          details: { sessions: [], currentSessionId: null },
        };
      }

      const index = labels.indexOf(choice);
      const selected = list[index];
      setCurrentSession(selected.id);
      ctx.ui.notify(`已选择: ${selected.name}`, "info");

      return {
        content: [{
          type: "text",
          text: `已选择会话：${selected.name}\n类型：${selected.type}\nID：${selected.id}\n缓存消息：${selected.messageCache.length} 条`,
        }],
        details: {
          sessions: list.map(s => ({
            id: s.id, type: s.type, name: s.name,
            guild_id: s.guild_id, channel_id: s.channel_id,
            group_openid: s.group_openid, user_openid: s.user_openid,
            lastActive: s.lastActive,
          })),
          currentSessionId: selected.id,
        },
      };
    },
  });

  // --- qq_get_messages ---
  pi.registerTool({
    name: "qq_get_messages",
    label: "获取 QQ 消息",
    description: "获取指定会话的消息历史。频道支持 API 历史，群聊/C2C 通过 WebSocket 实时缓存提供。",
    parameters: Type.Object({
      limit: Type.Optional(Type.Integer({ default: 20, minimum: 1, maximum: 100 })),
      before: Type.Optional(Type.String({ description: "锚定消息 ID（仅频道）" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const session = getCurrentSession();
      if (!session) throw new Error("请先使用 qq_select_session 选择会话");

      let messages: QBCachedMessage[] = [];

      if (session.type === "guild_channel" && session.channel_id) {
        // 频道 API
        const result = await getChannelMessages(session.channel_id, params.limit ?? 20, params.before);
        messages = result.map((m: any) => ({
          id: m.id, content: m.content, author: m.author?.username || "unknown",
          timestamp: new Date(m.timestamp).getTime(), isSelf: false,
        }));
      } else {
        // 缓存读取
        const cache = session.messageCache;
        const limit = params.limit ?? 20;
        messages = (params.before
          ? cache.slice(0, cache.findIndex(m => m.id === params.before)).slice(-limit)
          : cache.slice(-limit)
        ).reverse();
      }

      if (messages.length === 0) {
        return {
          content: [{ type: "text", text: "该会话暂无消息。" }],
          details: { messages: [] },
        };
      }

      const formatted = messages.map(m =>
        `[${new Date(m.timestamp).toLocaleString("zh-CN")}] ${m.author}: ${m.content}`
      ).join("\n");

      ctx.ui.notify(`获取到 ${messages.length} 条消息`, "info");

      return {
        content: [{
          type: "text",
          text: `会话「${session.name}」消息（${messages.length} 条）：\n\n${formatted}`,
        }],
        details: { messages: messages.slice(0, 30) },
      };
    },
  });

  // --- qq_send_message ---
  pi.registerTool({
    name: "qq_send_message",
    label: "发送 QQ 消息",
    description: "向已选中的 QQ 会话发送文本消息。注意主动消息有每月 4 条/用户的频率限制。",
    parameters: Type.Object({
      content: Type.String({ minLength: 1, maxLength: 2000 }),
      msg_type: Type.Optional(Type.Integer({ default: 0 })),
      confirm_send: Type.Optional(Type.Boolean({ default: false })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const session = getCurrentSession();
      if (!session) throw new Error("请先使用 qq_select_session 选择会话");

      if (!params.confirm_send) {
        const ok = await ctx.ui.confirm(
          "确认发送",
          `发送到「${session.name}」：\n\n${params.content}`,
          { signal }
        );
        if (!ok) {
          return {
            content: [{ type: "text", text: "消息发送已取消" }],
            details: { sent: false },
          };
        }
      }

      onUpdate?.({ content: [{ type: "text", text: "正在发送..." }] });

      try {
        const result = await sendMessage(session, params.content, params.msg_type ?? 0);
        cacheSelfMessage(session.id, params.content);
        ctx.ui.notify("消息已发送", "info");
        return {
          content: [{ type: "text", text: `消息已发送到「${session.name}」，ID: ${result.id || "N/A"}` }],
          details: { sent: true, messageId: result.id },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("401")) await refreshToken();
        throw new Error(`发送失败: ${msg}`);
      }
    },
  });
}
```

---

## 九、潜在风险与注意事项

### 9.1 Token 安全存储

| 问题 | 方案 |
|---|---|
| `client_secret` 相当于密码，明文存储风险高 | **不要**用 `pi.appendEntry()` 持久化 secret。推荐方案： |
| | 1. 优先使用环境变量 `QQ_BOT_APP_ID` + `QQ_BOT_CLIENT_SECRET` |
| | 2. 仅在当前 session 内存中持有 secret，不落盘 |
| | 3. 如需持久化，加密后写入 `~/.pi/qq-bot.enc`（使用 Node.js `crypto.createCipheriv`） |
| | 4. `/qq-config` 命令接受参数后立即使用，不持久化参数原文 |
| `access_token` 2 小时过期 | 可在内存中缓存，过期自动刷新。若 pi 重启，需要用户重新配置（或从加密存储恢复） |

### 9.2 API 速率限制

| 限制类型 | 详情 | 应对策略 |
|---|---|---|
| 主动消息 | 每月 4 条/用户或群 | 1. 在 `qq_send_message` 执行前通过 `confirm` 让用户明确知情 |
| | | 2. 内部维护发送计数器，超出时给出明确提示 |
| | | 3. 优先使用被动回复（48h 内有交互的会话限制更宽松） |
| API 调用频率 | QQ Bot 未公开具体 QPS | 1. 使用队列控制并发请求数（max 3） |
| | | 2. 遇到 429 时退避重试 |
| WebSocket 心跳 | 每 30 秒 | 使用 `ws` 包的 `ping`/`pong` 机制自动处理 |

### 9.3 错误处理与重试

```
调用失败
   │
   ├── 401 Unauthorized
   │   → 刷新 access_token
   │   → 重试原请求（最多 1 次）
   │
   ├── 404 Not Found
   │   → 会话可能已失效，提示用户重新选择
   │   → 从会话列表中移除
   │
   ├── 429 Too Many Requests
   │   → 读取 Retry-After 头
   │   → 等待后重试（最多 3 次指数退避）
   │
   ├── 5xx Server Error
   │   → 退避重试（3 次）：1s → 3s → 9s
   │
   ├── WebSocket 断开
   │   → 指数退避重连：1s → 2s → 4s → ... → 60s max
   │   → 优先使用 Resume（OpCode 6）恢复 session
   │   → Resume 失败（9 Invalid Session）时重新 Identify
   │
   └── Token 过期
       → 提前 5 分钟定时刷新
       → 遇到 401 时立即刷新 + 重试
```

### 9.4 用户隐私

| 关注点 | 措施 |
|---|---|
| 消息内容存储 | 消息缓存仅在内存中（`messageCache`），最多 500 条/会话，session 关闭即丢失 |
| 不在 LLM 上下文暴露敏感信息 | `details` 中的消息默认只保留 30 条，且内容为纯文本 |
| 用户选择权 | 发送消息前通过 `confirm` 让用户确认内容和目标 |
| 不主动发送 | 所有 `qq_send_message` 调用必须经过用户确认（除非明确设置 `confirm_send: true`） |
| AppID/Secret 泄露 | 不在日志中打印 secret，error message 中截断敏感信息 |

### 9.5 已知功能限制

| 限制 | 说明 |
|---|---|
| 群聊/好友无历史 API | 只能通过 WebSocket 连接后实时缓存消息，退出后缓存丢失 |
| 群聊/好友无列表 API | 只能通过 `GROUP_ADD_ROBOT` / `FRIEND_ADD` 事件被动收集，无法主动获取 |
| 频道需要 Bot 在频道内 | 获取频道列表 API 只返回 Bot 已加入的频道 |
| OpenID 非固定不变 | 不同 Bot 对同一用户的 `openid` 不同，不能跨 Bot 使用 |
| 图片/文件消息 | 本方案初期仅支持文本和 Markdown，富媒体需额外实现上传逻辑 |
| Markdown 模板 | QQ Bot 的 Markdown 需要先在开发者平台注册模板，不支持自由 Markdown |

### 9.6 扩展热重载注意事项

- `/reload` 会重新加载扩展，导致 WebSocket 断开重连
- 所有内存状态（token、session 缓存）会丢失
- 建议在 reload 前先通过 `pi.appendEntry("qq-auth", ...)` 持久化 auth 状态
- `session_start` 事件中恢复状态可以减少影响

---

## 十、开发与安装指引

### 10.1 安装

```bash
# 进入 pi 扩展目录
cd ~/.pi/agent/extensions

# 克隆或创建目录
mkdir -p qq-integration
cd qq-integration

# 创建 package.json
# 复制所有源文件
# 安装依赖
npm install
```

### 10.2 配置

1. 前往 [QQ 开放平台](https://q.qq.com/) 创建 Bot，获取 AppID 和 ClientSecret
2. 在 pi 中执行 `/qq-config <AppID> <ClientSecret>`
3. 或者设置环境变量（推荐）：
   ```bash
   export QQ_BOT_APP_ID="your_app_id"
   export QQ_BOT_CLIENT_SECRET="your_client_secret"
   ```

### 10.3 使用流程

```
1. /qq-config your_app_id your_client_secret
   → 认证成功，WebSocket 自动连接

2. 让 LLM 调用 qq_select_session
   → 用户选择会话

3. 让 LLM 调用 qq_get_messages（可选）
   → 查看历史消息

4. 让 LLM 调用 qq_send_message { content: "你好" }
   → 用户确认后发送

5. /qq-status
   → 查看连接状态和会话数量
```
