# pi-qq-integration

**Control pi from QQ.** A [pi](https://github.com/earendil-works/pi) extension that connects your pi coding agent to QQ via the official QQ Bot API. Send prompts, browse sessions, view history, and toggle forwarding — all from a QQ chat window.

[中文文档](./README.zh-CN.md)

---

## Install

```bash
pi install npm:pi-qq-integration
```

---

## Quick Start

### 1. Register a QQ Bot

Create a bot application on the [QQ Open Platform](https://q.qq.com) to obtain your **AppID** and **AppSecret**.

### 2. Create a config file

Create `~/.pi/agent/qq-integration-config.json`:

```json
{
  "appId": "your-app-id",
  "appSecret": "your-app-secret"
}
```

### 3. Start pi

```bash
pi
```

The extension loads and **automatically connects** to QQ Bot by default. To disable auto-connect, add `"autoConnect": false` to the config file and use `/qq-connect` manually. Send a message to your bot in QQ — it'll be forwarded to pi as a prompt.

---

## Configuration

Config file path: `~/.pi/agent/qq-integration-config.json`

### Top-level fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `appId` | string | ✅ | — | QQ Bot application AppID |
| `appSecret` | string | ✅ | — | QQ Bot application AppSecret (**sensitive — never commit to git**) |
| `instanceId` | string | ❌ | `hostname-pid` | Unique ID for this pi instance (used in multi-instance registry) |
| `role` | `"auto" \| "leader" \| "follower"` | ❌ | `"auto"` | Multi-instance role: `auto` = file-lock election; `leader` = force QQ connection holder; `follower` = connect via IPC to leader |
| `autoConnect` | boolean | ❌ | `true` | Auto-connect QQ Bot on pi startup; set `false` to require manual `/qq-connect` |
| `allowedUsers` | string[] | ❌ | — | Whitelist of c2c user openids allowed to send prompts to pi. If unset, **all** QQ private messages are processed (with a security warning). Strongly recommended to prevent remote prompt injection |
| `allowedGroups` | string[] | ❌ | — | Whitelist of group openids allowed to send prompts to pi. If unset, all group @-bot messages are processed |

### `settings` field (forwarding options)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `forwardDesktopMessages` | boolean | `false` | Forward messages typed in the pi terminal to QQ |
| `forwardToolCalls` | boolean | `false` | Forward tool calls **and their results** to QQ (mutually exclusive with `lastMessageOnly`; enabling one auto-disables the other, enforced both in config and via `#settings`) |
| `lastMessageOnly` | boolean | `false` | Only forward the **final** assistant reply per agent run (mutually exclusive with `forwardToolCalls`; enabling one auto-disables the other) |
| `defaultSession` | object \| undefined | `undefined` | Default QQ session target for desktop/tool forwarding. **Auto-updated** to the source of the most recent incoming QQ message; also settable via `/qq-target` or QQ `#target` |

> `settings` fields can be configured statically in the config file or changed dynamically in QQ using `#settings` commands (see [QQ Commands](#qq-commands) below). Settings are persisted to the config file.

### Full example

```json
{
  "appId": "your-app-id",
  "appSecret": "your-app-secret",
  "autoConnect": true,
  "role": "auto",
  "settings": {
    "forwardDesktopMessages": false,
    "forwardToolCalls": false,
    "lastMessageOnly": false
  }
}
```

### Environment variables

| Variable | Description |
|----------|-------------|
| `QQ_INTEGRATION_DATA_DIR` | Override data directory (default: `~/.pi/agent`) |
| `QQ_API_BASE` | Override QQ API base URL (default: `https://api.sgroup.qq.com`) |
| `QQ_TOKEN_API` | Override Token API endpoint (default: `https://bots.qq.com/app/getAppAccessToken`) |

### Multi-instance

When running multiple pi instances simultaneously, a file-lock elects a single **leader** to hold the QQ WebSocket connection. Other instances become **followers** and delegate QQ send/receive to the leader via local Unix socket IPC.

- `role: "auto"` (default) — first instance to acquire the lock becomes leader; rest become followers.
- `role: "leader"` / `"follower"` — force a specific role.
- `instanceId` — usually unnecessary; set only for fixed IDs in logs/registry.

---

## Architecture

```
QQ User
  │
  ├─ Send message → QQ Bot Server → WebSocket
  │                                      │
  │                      ┌───────────────▼───────────────┐
  │                      │  pi-qq-integration extension   │
  │                      │                                │
  │                      │  ws-client.ts                  │
  │                      │    ↕ WebSocket (long-lived)    │
  │                      │  command-handler.ts            │
  │                      │    ↕ #cmd parsing              │
  │                      │  index.ts                      │
  │                      │    ↕ sendUserMessage           │
  │                      └───────────────┬───────────────┘
  │                                      │
  │                      ┌───────────────▼───────────────┐
  │                      │        pi engine               │
  │                      │   processes prompt & replies   │
  │                      └───────────────┬───────────────┘
  │                                      │
  └─────── REST API ←──── reply content
```

Two independent channels:
- **WebSocket** — receives QQ messages (long-lived connection with heartbeat and auto-reconnect)
- **REST API** — sends replies to QQ, POSTing to the endpoint matching session type: `/v2/users/{openid}/messages` (c2c), `/v2/groups/{group_openid}/messages` (group), or `/channels/{channel_id}/messages` (channel)

---

## pi Slash Commands

Commands used in the pi terminal:

| Command | Description |
|---------|-------------|
| `/qq-connect` | Manually connect QQ Bot |
| `/qq-disconnect` | Disconnect QQ Bot |
| `/qq-status` | Connection overview (role, lock, WebSocket, Token) |
| `/qq-diagnose` | Detailed diagnostics (session_id, heartbeat, reconnect count, etc.) |
| `/qq-logs` | View last 30 log entries |
| `/qq-logs-path` | Show log file path |
| `/qq-logs-clear` | Clear log file |
| `/qq-target` | Set/view default QQ forwarding target |

---

## QQ Commands

Messages sent in QQ that start with `#` are treated as commands. Anything else is forwarded to pi as a prompt.

| Command | Description |
|---------|-------------|
| `#help` | Show help |
| `#sessions` | List all pi sessions |
| `#resume <index/name>` | Switch to a session (operates in terminal) |
| `#new` | Create a new session (operates in terminal) |
| `#history [N]` | View last N messages in the most recently active session (default: 5) |
| `#clear` | Compact current session (operates in terminal) |
| `#target` | Set current QQ conversation as default forwarding target |
| `#settings` | View/modify forwarding settings (`#setting` is an alias) |

### `#settings` examples

```
You: #settings
Bot: ## ⚙️ QQ Bot 设置
     | 选项 | 状态 | 说明 |
     | forwardMessages | ❌ 关 | 桌面端消息转发到 QQ |
     | forwardTools | ✅ 开 | 工具调用转发到 QQ |
     | lastMessageOnly | ❌ 关 | 只转发整次回复的最后一条 assistant 回复 |

You: #settings forwardTools on
Bot: ✅ **工具调用转发** 已开启，同时 `lastMessageOnly` 已自动关闭。

You: #settings lastMessageOnly on
Bot: ✅ **只转发最后一条回复** 已开启，assistant 整次运行仅发送一条最终回复；`forwardTools` 已自动关闭。
```

> Bot replies are hardcoded in Chinese regardless of locale.

### Desktop message forwarding

When `forwardDesktopMessages` is enabled, messages typed in the pi terminal are forwarded to QQ. The target is selected by priority:

1. The most recent QQ message's source session (incoming QQ messages auto-update `defaultSession`)
2. The manually set default target (`/qq-target` or QQ `#target`) — only used before any QQ message has been received

> **Note:** Messages forwarded from QQ into pi are prefixed with a source tag (`[QQ]` for private chat, `[QQ群]` for group). This prefix is also used to detect and skip desktop echoes, preventing forwarding loops.

```bash
# Set default target in pi terminal
/qq-target c2c <user-openid> [name]      # Private chat (name optional)
/qq-target group <group-openid> [name]   # Group chat
/qq-target channel <channel-id> [name]   # Channel
/qq-target                               # View current target (alias: show)
/qq-target clear                         # Clear

# Or in QQ: send #target to set current conversation as target
```

---

## File structure

```
pi-qq-integration/
├── index.ts              # Entry: init, events, slash commands
├── constants.ts          # Centralized constants (paths, URLs, timeouts)
├── config.ts             # Config file read/write (atomic writes)
├── auth.ts               # QQ Bot access token management + auto-refresh
├── lock.ts               # File lock (O_EXCL atomic creation, multi-instance)
├── ws-client.ts          # WebSocket client (connect, auth, heartbeat, reconnect)
├── api-client.ts         # REST API client (send messages)
├── ipc.ts                # Unix socket IPC (leader-follower delegation)
├── registry.ts           # Instance registry (atomic writes)
├── session-manager.ts    # Pi session browser
├── command-handler.ts    # QQ #command parser
├── logger.ts             # File logger with rotation
├── types.ts              # Type definitions
└── package.json
```

---

## Multi-instance details

```
~/.pi/agent/
├── qq-integration.lock          # File lock (O_EXCL atomic creation)
│   └─ JSON: { pid, startedAt, heartbeatAt }  (heartbeat every 30s)
└── qq-integration/
    ├── registry.json             # Instance registry (atomic write)
    └── instances/
        └── <pid>.sock            # IPC Unix socket (leader)
```

- First pi instance acquires the lock → becomes leader → connects QQ Bot
- Subsequent instances detect the lock → become followers → connect to leader via IPC
- If the leader crashes, its PID becomes invalid → next instance takes over the lock

---

## Logging

All debug logs are written to:

```
~/.pi/agent/qq-integration.log
```

Use `/qq-logs` in pi to view the last 30 entries, or `/qq-logs-path` for the file path. Log files are truncated (cleared) at 5 MB.

---

## Notes

1. **Token security** — Access tokens expire in ~2 hours and are auto-refreshed. After 3 consecutive refresh failures, the extension disconnects and notifies the user.
2. **Message rate limits** — QQ Bot proactive messages are limited to 4 per user/group per month. Passive replies have more relaxed limits.
3. **Session management** — Session switching (`/new`, `/resume`) must be done in the pi terminal.
4. **Settings persistence** — `#settings` changes are saved to `qq-integration-config.json` and survive `/reload`.
5. **Group messages** — Only @-bot messages are received (`GROUP_AT_MESSAGE_CREATE`).
6. **Config file** — Contains AppSecret. Never commit it to git.

---

## Development

```bash
cd ~/.pi/agent/extensions/pi-qq-integration
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm run typecheck    # Type check only
# Edit code, then /reload in pi to hot-reload
```

---

## Contributors

<a href="https://github.com/Star-233"><img src="https://github.com/Star-233.png?size=100" width="100" height="100" alt="Star-233" /></a>
<a href="https://github.com/illusionlie"><img src="https://github.com/illusionlie.png?size=100" width="100" height="100" alt="illusionlie" /></a>

Thanks to [@illusionlie](https://github.com/illusionlie) for the Windows IPC bug report (#1) and fix PR (#2).
