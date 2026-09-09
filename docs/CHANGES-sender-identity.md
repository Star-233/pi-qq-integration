# 变更总结：消息来源用户身份识别（方案 A + B）

> 分支建议：`feat/sender-identity` · 基线：v0.5.3（0c88831）· 版本：0.5.4

## 背景与问题

扩展原先把 QQ 消息转发给 pi 时只带 `[QQ]`（私聊）或 `[QQ群]`（群聊）标签，pi 的大模型无法区分消息来自哪个用户。同一群内不同成员的消息、以及不同来源的消息在 pi 看来完全相同。

**QQ 平台约束**（官方文档《唯一身份机制》）：

- 单聊事件提供 `user_openid`，群聊事件提供 `member_openid`（发送者在该群内的标识）
- 同一用户对同一机器人：私聊 openid、A 群 openid、B 群 openid **互不相同**，官方无 unionid 打通机制
- `author.username`（昵称）在群聊事件中通常为空，无保证

因此采用两层方案：

- **方案 A（自动，无条件生效）**：消息前缀携带发送者 openid（前 12 位）及 QQ 侧返回的昵称（如有）
- **方案 B（人工映射表）**：openid → 别名映射文件，把同一自然人在私聊/各群的多个 openid 指到同一别名，实现跨场景身份关联；命中别名时前缀用别名替代昵称

## 转发格式变化

| 场景 | 之前 | 现在 |
|------|------|------|
| 私聊 | `[QQ] 内容` | `[QQ\|张三\|openid:AbCdEf12] 内容` |
| 群聊（QQ 返回了昵称） | `[QQ群] 内容` | `[QQ群\|张三\|openid:AbCdEf12] 内容` |
| 群聊（无昵称，常见） | `[QQ群] 内容` | `[QQ群\|openid:AbCdEf12] 内容` |
| 映射表命中 | — | `[QQ群\|张三\|openid:AbCdEf12] 内容`（张三 = 人工登记的别名） |
| 信息全缺失 | `[QQ群] 内容` | `[QQ群] 内容`（完全向后兼容） |

前缀仍以 `[QQ` 开头，`index.ts` 中对 QQ 回声消息的过滤规则不受影响。

## 新增/修改文件

| 文件 | 变更 |
|------|------|
| `aliases.ts`（新增） | 映射表模块：读写 `~/.pi/agent/qq-integration/aliases.json`、mtime 热重载、前缀模糊匹配、别名清洗（去控制字符/截断 32 字）、条目上限 1000、脏数据容错 |
| `constants.ts` | `PATHS` 新增 `ALIASES` 路径 |
| `index.ts` | ① 新增 `senderPrefix()`：构造带发送者身份的前缀（别名 > QQ 昵称 > openid 短码），替换原两处 `[fromTag]` 转发；② 新增 `/qq-alias` 命令（list/set/del）；③ 未登记 openid 首次出现时在转发消息末尾附加登记提示（含完整 openid，每次运行每 openid 一次，防刷屏） |
| `test/aliases.test.mjs`（新增） | 13 个用例：增删改查、前缀歧义、别名清洗、热重载、脏数据容错、openid 形态校验 |
| `docs/alias-mapping-guide.md`（新增） | 映射表使用说明 |
| `README.md` / `README.zh-CN.md` | Slash 命令表新增 `/qq-alias`；新增「消息来源识别与别名映射」章节；文件树补 `aliases.json` |
| `CHANGELOG.md` | 新增 0.5.4 变更条目 |
| `package.json` / `package-lock.json` | 版本号 0.5.3 → 0.5.4 |

`dist/` 已重新编译（`npm run build`）。

## /qq-alias 命令

```
/qq-alias list                          # 列出全部（按别名排序）
/qq-alias set <openid或唯一前缀> <别名>   # 新增/更新；前缀需唯一命中已有条目
/qq-alias del <openid或唯一前缀>         # 删除
```

映射文件可直接手动编辑，保存即生效（热重载），所有实例共享。

## 验证

- `tsc --noEmit` 类型检查通过
- 测试：65 用例 / 58 通过；7 个失败**全部为改动前就存在的 Windows 环境问题**（6 个 IPC 命名管道用例 + 1 个 0600 文件权限用例），已用 `git stash` 在原始代码上复现确认
- 新增 13 个别名测试全部通过

## 已知限制

1. 跨场景身份关联依赖人工登记（QQ 平台 openid 机制决定，无自动方案）
2. 群聊昵称通常拿不到（QQ 不下发），未登记别名时只能靠 openid 短码区分成员
3. openid 短码取前 12 位，仅用于展示；映射表内部使用完整 openid
4. QQ 端 `#alias` 命令暂未提供（存在群成员滥用风险，需配合白名单，列为后续计划）

## 后续计划（可选）

- QQ 端 `#alias` 命令（仅白名单用户可用）
- 首次见到某 openid 时在 pi 会话中提示“新来源”（当前仅提示未登记，后续可扩展新/回访区分）
