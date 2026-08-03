## 测试体系

- 新增 `npm test`（`node --test`，零第三方依赖，Node ≥ 20 内置测试框架）
- `test/` 目录 5 个测试文件、38 个用例：
  - `validation.test.mjs` — session 结构/sessionKey/参考名清洗校验
  - `routing.test.mjs` — ref_idx 精确路由、署名兜底、#to 解析（纯函数，依赖注入）
  - `lock.test.mjs` — 文件锁互斥/死亡接管/同 PID 恢复/心跳（临时目录 + 子进程）
  - `registry.test.mjs` — registry 读写/认领唯一性/leader 记录/pruneDead（`QQ_INTEGRATION_DATA_DIR` 隔离）
  - `ipc.test.mjs` — IPC 真实 socket 收发/同 id 重连接管/非法注册断开
- 纯逻辑抽离到独立模块：`validation.ts`（校验）、`routing.ts`（路由），index.ts 直接 import（不再测试逻辑副本）

## 0.5.0

**新功能：多实例消息来源标识 + 定向回复路由**

### 新增
- **出站消息统一署名**：所有发往 QQ 的消息自动加 `【instanceId】` 前缀，用户可一眼辨别消息来自哪个 pi 实例
- **标识统一**：实例内部唯一标识默认 = PID（`#to <PID>` 切换，去掉了 hostname）；**出站署名显示 `> 【session名-PID】`**（未命名 session 时 `> 【PID】`），引用路由按署名尾部 PID 兜底匹配
- **leader 故障转移**：follower 重连循环中定期尝试接管锁（`lock.acquire`，检测旧 leader PID 死亡/锁释放），成功后自动升级为新 leader，避免 leader 退出后 follower 无限重连；配置 `role: follower` 强制跟随时不升级
- **实例显示名 = 当前活跃 pi session 名**：自动取 pi session 名（`/rename` 可自定义），回退 hostname/instanceId；session 切换或重命名时自动同步到注册表
- **引用消息定向路由**：用户在 QQ 中「引用」某条消息回复时，按被引用消息的来源实例精确路由（基于 `ref_idx` 映射，60 分钟 TTL）；映射未命中时按消息署名兜底匹配
- **`#to <实例> [内容]` 命令**：查看当前会话绑定实例 / 切换会话到指定实例 / 定向发送内容；支持含空格的实例名（最长前缀匹配），重名时提示使用 instanceId
- **`#instances` 命令**：列出所有在线实例（显示名/角色/认领会话数）
- 群聊（GROUP_AT_MESSAGE_CREATE）同样支持引用消息解析（需实测确认）

### 安全加固（审计后）
- 修复：`#to` 确认回复不再回夺会话认领（follower 场景下切换失效的严重 bug）
- 安全：IPC 新增端点（inject/reroute/instance_update）全量结构校验 + 权限约束（inject 仅合法实例、reroute 仅当前 claimer）
- 安全：register 连接级唯一性校验（防伪造实例条目/身份接管）
- 安全：引用署名兜底改为唯一匹配 + 校验被引用消息确为机器人所发（防消息定向劫持）
- 安全：实例名自动唯一化（重名加后缀，防署名冒用/定向歧义）
- 安全：isAllowed 未知会话类型一律拒绝（防伪造类型绕过白名单）
- 安全：`#instances` 输出脱敏（不再暴露 instanceId/主机名/PID）
- 加固：显示名清洗（去控制字符/限长）、markdown 转义增强、refIdxMap 硬上限驱逐、leader 命令回复也记录 ref_idx

### 已知限制
- registry 多进程写入为无锁 read-modify-write（原子写防损坏，但跨进程存在极小丢失更新窗口；依赖 30s pruneDead 收敛）
- 引用路由的精确匹配依赖 QQ API 返回 `ext_info.ref_idx` 与引用事件 `ref_msg_idx`，需真实环境实测；未返回时自动降级为署名唯一匹配
- `#to <名> <内容>` 中实例名与内容存在前缀歧义时（如 `web` 与 `web dev`），优先匹配更长实例名，可用 `#to` 切换后单独发消息规避

# Changelog

## 0.4.4

- 安全加固：新增 QQ 消息白名单（`allowedUsers`/`allowedGroups`）防远程提示词注入
- 安全加固：配置/日志/registry/lock 文件权限收紧为 0600/0700
- 安全加固：IPC 消息大小限制（防 OOM）、session.id 校验（防路径穿越）、auth 错误响应体截断
- 修复：API 401 时真正强制刷新 token（此前未绕过本地缓存）
- 修复：IPC settings_update 增加 schema 校验与互斥归一
- 文档：README 中英文拆分为独立文件（README.md + README.zh-CN.md），新增贡献者展示
- 文档：修正 12 处文档与代码不一致（#settings 示例、日志截断说明、REST 端点、/qq-target 用法等）

## 0.4.3

- 更新 npm 包描述为中英双语。

## 0.4.2

- README: 重写为中英双版，英文在前默认。

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
