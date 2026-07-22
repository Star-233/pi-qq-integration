# QQ Integration — pi 扩展

在 **QQ 中操控 pi**。安装此扩展后，pi 启动时自动连接 QQ Bot，你可以通过 QQ 向 pi 发消息、查看 session 列表、浏览历史对话。

---

## 快速开始

### 1. 注册 QQ Bot

在 [QQ 开放平台](https://q.qq.com) 创建一个机器人应用，获取 **AppID** 和 **AppSecret**。

### 2. 创建配置文件

```json
# /home/nullsky/.pi/agent/qq-integration-config.json
{
  "appId": "你的 AppID",
  "appSecret": "你的 AppSecret"
}
```

### 3. 启动 pi，手动连接

```bash
pi
# 扩展加载后，输入:
/qq-connect
```

扩展不会自动连接 Bot，你需要手动输入 `/qq-connect`。断开用 `/qq-disconnect`。

现在在 QQ 中给机器人发消息，就能和 pi 对话了。

---

## 架构

```
QQ 用户
  │
  ├─ 发消息 → QQ Bot 服务器 → WebSocket
  │                                │
  │                     ┌──────────▼──────────┐
  │                     │  qq-integration 扩展  │
  │                     │                      │
  │                     │  ws-client.ts        │
  │                     │    ↕ WebSocket       │
  │                     │  command-handler.ts  │
  │                     │    ↕ /cmd 解析       │
  │                     │  index.ts            │
  │                     │    ↕ sendUserMessage │
  │                     └──────────┬──────────┘
  │                                │
  │                     ┌──────────▼──────────┐
  │                     │      pi 引擎         │
  │                     │   处理 prompt 并回复  │
  │                     └──────────┬──────────┘
  │                                │
  └─────── REST API ←──── 回复内容
```

两个独立通道：
- **WebSocket** — 接收 QQ 消息（长连接，带心跳和断线重连）
- **REST API** — 发送回复到 QQ（`POST /v2/users/{openid}/messages`）

---

## pi Slash 命令

在 pi 终端中使用的命令：

| 命令 | 说明 |
|------|------|
| `/qq-connect` | 手动连接 QQ Bot |
| `/qq-disconnect` | 断开 QQ Bot 连接 |
| `/qq-status` | 查看连接状态概览（锁、WebSocket、Token） |
| `/qq-diagnose` | 查看详细诊断信息（session_id、心跳、重连次数等） |
| `/qq-logs` | 查看最近 30 条日志 |
| `/qq-logs-path` | 查看日志文件路径 |

### `/qq-status` 示例

```
🔒 锁: 持有中
🟢 WebSocket: 已连接
⏱ 已运行: 2分35秒
✅ Token: 有效
```

### `/qq-diagnose` 示例

```
🔒 锁状态
  - 持有锁: ✅ 是
  - 锁文件 PID: 12345
  - 本进程 PID: 12345

🌐 WebSocket 连接
  - 状态: 已连接
  - Session ID: xxxx
  - 重连次数: 0

🔑 Access Token
  - 过期时间: 2026-07-21 17:30
  - 剩余时间: 1时58分

⚙️ 配置
  - AppID: 你的 AppID
```

---

## QQ 命令

在 QQ 中给机器人发送的消息，如果不以 `/` 开头，会直接作为 prompt 发给 pi。

| 命令 | 说明 |
|------|------|
| `#help` | 显示帮助 |
| `#sessions` | 列出所有 pi session |
| `#resume <序号/名称>` | 切换到指定 session（在终端中操作） |
| `#new` | 创建新 session（在终端中操作） |
| `#history [N]` | 查看当前 session 最近 N 条消息（默认 5） |
| `#clear` | 清空当前 session（在终端中操作） |

### 示例

```
你: #sessions
Bot: 📋 Pi Sessions
     1. **extensions 07:03** — 2小时前
     2. **learn 05:29** — 2小时前
     ...

你: #history 5
Bot: 📝 最近消息 (extensions 07:03)
     👤 今天天气怎么样？
     🤖 今天天气晴朗...
```

### `#settings`

转发设置在 `/reload` 后永久保存：

```
你: #settings
Bot: ⚙️ QQ Bot 设置
     | 选项 | 状态 | 说明 |
     | forwardMessages | ❌ 关 | 桌面端消息转发到 QQ |
     | forwardTools | ✅ 开 | 工具调用转发到 QQ |

你: #settings forwardTools on
Bot: ✅ 工具调用转发已开启

你: #settings forwardMessages off
Bot: ❌ 桌面消息转发已关闭
```

---

## 文件结构

```
qq-integration/
├── index.ts              # 入口：初始化、事件注册、slash 命令
├── config.ts             # 读取 qq-integration-config.json
├── auth.ts               # QQ Bot Access Token 获取 + 自动刷新
├── lock.ts               # 文件锁（多实例防冲突）
├── ws-client.ts          # WebSocket 客户端（连接、鉴权、心跳、重连）
├── api-client.ts         # REST API 客户端（发送消息）
├── session-manager.ts    # Pi session 浏览
├── command-handler.ts    # QQ 消息中的 /cmd 命令解析
├── types.ts              # 类型定义
├── package.json          # 依赖（ws）
└── README.md
```

---

## 多实例处理

如果同时启动多个 pi 实例，扩展使用**文件锁**机制确保只有一个实例连接 QQ Bot：

```
~/.pi/agent/qq-integration.lock
  ├── PID: 持有者进程 ID
  ├── 获取时间
  └── 心跳时间（每 30 秒更新）
```

- 第一个启动的 pi 获取锁并连接 Bot
- 后续实例检测到锁被持有，跳过连接
- 持有锁的实例崩溃后，锁文件中的 PID 失效，后续实例自动接管

---

## 日志

所有调试日志写入文件：

```
/home/nullsky/.pi/agent/qq-integration.log
```

在 pi 中可用 `/qq-logs` 查看最近 30 条，用 `/qq-logs-path` 查看文件路径。
日志文件达到 5MB 会自动截断。

## 注意事项

1. **Token 安全** — `access_token` 有效期 2 小时，扩展会自动提前刷新
2. **消息频率** — QQ Bot 主动消息每月每用户/群限 4 条，被动回复较宽松
3. **Session 管理** — session 切换（`/new`、`/resume`）需在 pi 终端中操作
4. **`#settings` 持久化** — 设置保存在 `qq-integration-config.json` 中，`/reload` 不丢失
4. **群聊消息** — 仅接收 @机器人的群消息（`GROUP_AT_MESSAGE_CREATE`）
5. **配置文件** — 含 AppSecret，注意不要提交到 git

---

## 开发

```bash
cd ~/.pi/agent/extensions/qq-integration
npm install          # 安装依赖
# 编辑代码后 /reload 即可热重载
```
