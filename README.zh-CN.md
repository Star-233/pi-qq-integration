[English](./README.md)

# pi-qq-integration — 中文版

在 **QQ 中操控 pi**。安装此扩展后，pi 启动时会自动加载扩展并**默认自动连接** QQ Bot（可在配置中关闭）。连接后即可通过 QQ 向 pi 发消息、查看 session 列表、浏览历史对话；也可随时用 `/qq-connect`、`/qq-disconnect` 手动控制连接。

---

## 安装

```bash
pi install npm:pi-qq-integration
```

---

## 快速开始

### 1. 注册 QQ Bot

在 [QQ 开放平台](https://q.qq.com) 创建一个机器人应用，获取 **AppID** 和 **AppSecret**。

### 2. 创建配置文件

创建 `~/.pi/agent/qq-integration-config.json`：

```json
{
  "appId": "你的 AppID",
  "appSecret": "你的 AppSecret"
}
```

### 3. 启动 pi

```bash
pi
```

扩展加载后会**自动连接** QQ Bot（默认行为）。如需关闭自动连接，在配置文件加 `"autoConnect": false` 后重启 pi，再用 `/qq-connect` 手动连接；断开用 `/qq-disconnect`。

现在在 QQ 中给机器人发消息，就能和 pi 对话了。

---

## 配置项（qq-integration-config.json）

配置文件路径：`~/.pi/agent/qq-integration-config.json`（位于 pi 的 agent 数据目录，与扩展代码目录无关）。

### 顶层字段

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `appId` | string | ✅ | — | QQ 开放平台机器人应用的 AppID |
| `appSecret` | string | ✅ | — | QQ 开放平台机器人应用的 AppSecret（**敏感，勿提交 git**） |
| `instanceId` | string | ❌ | `hostname-pid` | 多实例下本实例的唯一 ID |
| `role` | `"auto" \| "leader" \| "follower"` | ❌ | `"auto"` | 多实例角色：`auto` 由文件锁自动选举；`leader` 强制持有 QQ 连接；`follower` 强制经 IPC 接入 leader |
| `autoConnect` | boolean | ❌ | `true` | pi 启动时是否自动连接 QQ Bot；设为 `false` 则需手动 `/qq-connect` |
| `allowedUsers` | string[] | ❌ | — | 允许向 pi 发 prompt 的 c2c 用户 openid 白名单。未配置则**放行所有**私聊消息（会输出安全告警）。强烈建议配置，以防远程提示词注入 |
| `allowedGroups` | string[] | ❌ | — | 允许向 pi 发 prompt 的群 openid 白名单。未配置则放行所有 @机器人消息 |

### `settings` 字段（转发设置）

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `forwardDesktopMessages` | boolean | `false` | 桌面端（pi 终端）输入的消息是否转发到 QQ |
| `forwardToolCalls` | boolean | `false` | 工具调用**及其结果**是否转发到 QQ（与 `lastMessageOnly` 互斥；开启一个会自动关闭另一个，配置文件与 `#settings` 均强制） |
| `lastMessageOnly` | boolean | `false` | 只转发整次 agent 运行的**最后一条** assistant 回复（与 `forwardToolCalls` 互斥；开启一个会自动关闭另一个） |
| `defaultSession` | object \| undefined | `undefined` | 默认 QQ 转发目标。收到 QQ 消息时会**自动更新**为该消息来源会话；也可由 `/qq-target` 或 QQ `#target` 设置 |

> `settings` 内的字段既可在配置文件里静态写死，也可在 QQ 内用 `#settings` 命令动态调整并持久化。`#settings` 命令对前两个开关使用了简写别名：`forwardMessages` 对应 `forwardDesktopMessages`，`forwardTools` 对应 `forwardToolCalls`。

### 完整示例

```json
{
  "appId": "你的 AppID",
  "appSecret": "你的 AppSecret",
  "autoConnect": true,
  "role": "auto",
  "settings": {
    "forwardDesktopMessages": false,
    "forwardToolCalls": false,
    "lastMessageOnly": false
  }
}
```

### 环境变量

| 变量 | 说明 |
|------|------|
| `QQ_INTEGRATION_DATA_DIR` | 覆盖数据目录（默认 `~/.pi/agent`） |
| `QQ_API_BASE` | 覆盖 QQ API 域名（默认 `https://api.sgroup.qq.com`） |
| `QQ_TOKEN_API` | 覆盖 Token API 地址（默认 `https://bots.qq.com/app/getAppAccessToken`） |

### 多实例

同时运行多个 pi 实例时，用文件锁选举唯一的 **leader** 持有 QQ 连接；其余实例作为 **follower** 经本地 Unix socket IPC 把 QQ 收发委托给 leader。

- `role: "auto"`（默认）：谁先抢到锁谁是 leader，其余自动成为 follower。
- `role: "leader"` / `"follower"`：强制角色。
- `instanceId`：一般无需修改；仅在需要固定 ID 时设置。

---

## 架构

```
QQ 用户
  │
  ├─ 发消息 → QQ Bot 服务器 → WebSocket
  │                                │
  │                     ┌──────────▼──────────┐
  │                     │  pi-qq-integration  │
  │                     │  ws-client.ts       │
  │                     │    ↕ WebSocket      │
  │                     │  command-handler.ts │
  │                     │    ↕ #cmd 解析      │
  │                     │  index.ts           │
  │                     │    ↕ sendUserMessage│
  │                     └──────────┬──────────┘
  │                                │
  │                     ┌──────────▼──────────┐
  │                     │      pi 引擎         │
  │                     │   处理 prompt 并回复   │
  │                     └──────────┬──────────┘
  │                                │
  └─────── REST API ←──── 回复内容
```

两个独立通道：
- **WebSocket** — 接收 QQ 消息（长连接，带心跳和断线重连）
- **REST API** — 发送回复到 QQ，按会话类型 POST 到对应端点：`/v2/users/{openid}/messages`（c2c）、`/v2/groups/{group_openid}/messages`（群）、`/channels/{channel_id}/messages`（频道）

---

## pi Slash 命令

| 命令 | 说明 |
|------|------|
| `/qq-connect` | 手动连接 QQ Bot |
| `/qq-disconnect` | 断开 QQ Bot 连接 |
| `/qq-status` | 查看连接状态概览（角色、锁、WebSocket、Token） |
| `/qq-diagnose` | 查看详细诊断信息 |
| `/qq-logs` | 查看最近 30 条日志 |
| `/qq-logs-path` | 查看日志文件路径 |
| `/qq-logs-clear` | 清空日志文件 |
| `/qq-target` | 设置/查看默认 QQ 转发目标 |

---

## QQ 命令

在 QQ 中给机器人发送的消息，如果不以 `#` 开头，会直接作为 prompt 发给 pi。

| 命令 | 说明 |
|------|------|
| `#help` | 显示帮助 |
| `#sessions` | 列出所有 pi session |
| `#resume <序号/名称>` | 切换到指定 session |
| `#new` | 创建新 session |
| `#history [N]` | 查看最近活跃 session 的最近 N 条消息（默认 5） |
| `#clear` | 压缩当前 session |
| `#target` | 将当前 QQ 会话设为默认转发目标 |
| `#settings` | 查看/修改转发设置（`#setting` 为别名） |

### 桌面端消息转发

开启桌面端转发（`#settings forwardMessages on`）后，桌面端输入的消息会同步转发到 QQ。目标按优先级选择：

1. 最近一条 QQ 消息来源的会话（收到 QQ 消息时会自动更新 `defaultSession`）
2. 手动设置的默认目标（`/qq-target` 或 QQ `#target`）——仅在尚未收到任何 QQ 消息时生效

> **注：** 从 QQ 转发进 pi 的消息会带来源标签前缀（私聊 `[QQ]`、群聊 `[QQ群]`）。该前缀也用于识别并跳过桌面端回响，避免转发回环。

```bash
/qq-target c2c <用户openid> [备注]        # 私聊（备注可选）
/qq-target group <群openid> [备注]         # 群聊
/qq-target channel <频道id> [备注]         # 频道
/qq-target                                 # 查看当前目标（别名：show）
/qq-target clear                           # 清除
```

### `#settings` 示例

```
你: #settings
Bot: ## ⚙️ QQ Bot 设置
     | 选项 | 状态 | 说明 |
     | forwardMessages | ❌ 关 | 桌面端消息转发到 QQ |
     | forwardTools | ✅ 开 | 工具调用转发到 QQ |
     | lastMessageOnly | ❌ 关 | 只转发整次回复的最后一条 assistant 回复 |

你: #settings forwardTools on
Bot: ✅ **工具调用转发** 已开启，同时 `lastMessageOnly` 已自动关闭。

你: #settings lastMessageOnly on
Bot: ✅ **只转发最后一条回复** 已开启，assistant 整次运行仅发送一条最终回复；`forwardTools` 已自动关闭。
```

---

## 文件结构

```
pi-qq-integration/
├── index.ts              # 入口：初始化、事件、slash 命令
├── constants.ts          # 集中常量（路径、URL、超时值）
├── config.ts             # 配置文件读写（原子写入）
├── auth.ts               # Token 管理 + 自动刷新
├── lock.ts               # 文件锁（O_EXCL 原子创建）
├── ws-client.ts          # WebSocket 客户端
├── api-client.ts         # REST API 客户端
├── ipc.ts                # Unix socket IPC
├── registry.ts           # 实例注册表（原子写入）
├── session-manager.ts    # Session 浏览
├── command-handler.ts    # #命令解析
├── logger.ts             # 文件日志（自动截断）
├── types.ts              # 类型定义
└── package.json
```

---

## 多实例细节

```
~/.pi/agent/
├── qq-integration.lock          # 文件锁（O_EXCL 原子创建）
│   └─ JSON: { pid, startedAt, heartbeatAt } （心跳每 30 秒更新）
└── qq-integration/
    ├── registry.json             # 实例注册表（原子写入）
    └── instances/
        └── <pid>.sock            # IPC Unix socket（leader）
```

- 第一个实例获取锁 → 成为 leader → 连接 QQ Bot
- 后续实例检测到锁 → 成为 follower → 通过 IPC 连接 leader
- leader 崩溃后 PID 失效 → 下一个实例自动接管

---

## 日志

所有调试日志写入 `~/.pi/agent/qq-integration.log`。使用 `/qq-logs` 查看最近 30 条，`/qq-logs-path` 查看路径。日志文件达到 5 MB 自动截断。

---

## 注意事项

1. **Token 安全** — Token 有效期约 2 小时，自动刷新。连续 3 次刷新失败后自动断开并通知。
2. **消息频率** — 主动消息每月每用户/群限 4 条，被动回复较宽松。
3. **Session 管理** — session 切换需在 pi 终端操作。
4. **设置持久化** — `#settings` 变更保存到配置文件，`/reload` 不丢失。
5. **群聊消息** — 仅接收 @机器人的消息。
6. **配置文件** — 含 AppSecret，勿提交 git。

---

## 开发

```bash
cd ~/.pi/agent/extensions/pi-qq-integration
npm install          # 安装依赖
npm run build        # 编译 TypeScript
npm run typecheck    # 仅类型检查
# 编辑代码后在 pi 中 /reload 热重载
```

---

## 贡献者

<a href="https://github.com/Star-233"><img src="https://github.com/Star-233.png?size=100" width="100" height="100" alt="Star-233" /></a>
<a href="https://github.com/illusionlie"><img src="https://github.com/illusionlie.png?size=100" width="100" height="100" alt="illusionlie" /></a>

感谢 [@illusionlie](https://github.com/illusionlie) 报告 Windows IPC bug (#1) 并提交修复 PR (#2)。
