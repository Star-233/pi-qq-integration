# Changelog

## 0.4.1

- 修复 `agent_settled` 事件处理器中访问 stale `ctx.sessionManager` 导致的崩溃（`lastMessageOnly=true` 时触发）。改为在 `message_end` 时缓存 assistant 消息内容，`agent_settled` 直接使用缓存，不再依赖可能过期的 ctx。

## 0.4.0

**重大重构：消除全部硬编码 + 修复多实例/网络/并发场景下的 22 个问题。**

### 新增
- 新增 `constants.ts`：集中管理所有常量（路径、API 端点、超时值），支持环境变量 `QQ_INTEGRATION_DATA_DIR`、`QQ_API_BASE`、`QQ_TOKEN_API` 覆盖。
- Settings IPC 同步机制：`#settings` 变更通过 leader 统一执行并广播给所有 follower，保持多实例内存状态一致。
- Auth 致命错误机制：Token 连续刷新失败 3 次后自动断开连接并通知用户，避免静默退化为僵尸状态。
- WS 鉴权失败回调 `onAuthFailed`：InvalidSession 时通知上层并 teardown。
- IPC `broadcast()` 方法：leader 可向所有 follower 广播消息。

### 修复
- **锁 TOCTOU 竞态**：`lock.ts` 改用 `openSync(path, "wx")` 原子创建（O_EXCL），消除两进程同时抢到锁的可能。
- **配置文件并发写入**：`config.ts` 和 `registry.ts` 改用 `atomicWrite`（写临时文件 + rename），消除 truncate 窗口导致配置损毁的风险。
- **`saveSettings` JSON.parse 失败保护**：解析失败时放弃写入，保护 appId/appSecret 不被覆盖为空。
- **WS `connect()` 过早 resolve**：延迟到 READY/RESUMED 事件后 resolve，确保 UI "已连接" 与实际鉴权状态一致。
- **WS 重连无限循环**：增加指数退避（1s → 2s → ... → 60s 上限）。
- **WS 超时未 terminate**：超时时 `ws.terminate()` 强制关闭半连接。
- **WS close handler 竞争**：`if (_ws === ws)` 守卫防止旧 close 清空新连接引用。
- **Follower 退避重试**：指数退避（2s → 4s → ... → 30s 上限），避免对死 socket 的固定间隔轮询。
- **IPC server close**：主动 `destroy()` 所有已有连接，而非仅停监听。
- **Follower teardown 自清 registry**：`removeInstance` 移到角色判断外，任何角色退出都清理自己的注册表条目。
- **Leader 启动立即 pruneDead**：`becomeLeader` 后立即执行一次清理，消除 30 秒延迟窗口。

### 重构
- 全部硬编码路径、URL、超时值、数值常量收口到 `constants.ts`，支持环境变量覆盖。
- 消除 `session-manager.ts` 中的 `"nullsky"` 用户名硬编码，改用 `userInfo().username`。
- 所有文件移除 `homedir()` 直接调用，统一引用 `PATHS`/`DEFAULTS`。

## 0.3.6

- 新增多实例支持（方案 A：文件锁选举 + 本地 Unix socket IPC 委派）：
  - 多个 pi 实例共享一个 QQ Bot 连接——抢到文件锁的为 leader（持有 QQ WebSocket），其余为 follower（经本地 IPC 把 QQ 收发委托给 leader），避免多实例各自连接被踢。
  - 新增 `registry.ts`（实例注册表）与 `ipc.ts`（IPC 服务/客户端）。
  - `config.role` 可强制 `auto`/`leader`/`follower`；`config.instanceId` 可固定实例 ID。
  - QQ 入站按会话认领（claim）路由到对应 follower；出站经 IPC 转 leader 发送。
- 新增 `autoConnect` 配置项（默认 `true`）：pi 启动时自动连接 QQ Bot；设为 `false` 则需手动 `/qq-connect`（撤销了 0.3.5 的"不自动连接"行为）。
- 更新 README：新增完整「配置项」章节，列出全部可配置字段（appId/appSecret/instanceId/role/autoConnect 及 settings 各项）。

## 0.3.5

- 修正 README 中"pi 启动时自动连接 QQ Bot"的错误描述，实际需手动输入 `/qq-connect` 连接。

## 0.3.4

- 修复 `lastMessageOnly` 转发重复问题：原实现监听 `turn_end` 事件，但 `turn_end` 每轮（turn）触发一次，agentic 模式下多步工具调用任务会在 QQ 中产生多条转发。
- 改用 `agent_settled` 事件（整次 agent 运行仅触发一次），从 `sessionManager.getEntries()` 取最后一条 assistant 消息转发，确保 QQ 只收到一条最终回复。
