# 别名映射表使用说明（/qq-alias）

## 这是什么

QQ 官方平台对同一用户在不同场景下发的 openid **互不相同**（私聊 `user_openid`、每个群内独立的 `member_openid`），且官方未提供 unionid 之类的打通机制。别名映射表让你把**同一个人的多个 openid 指到同一个别名**，使 pi 能跨私聊、跨群识别同一个用户。

命中别名后，转发给 pi 的消息前缀形如：

```
[QQ群|张三|openid:AbCdEf12] 帮我查天气
[QQ|张三|openid:Xy98wV76] 明天提醒我开会
```

（张三的两个不同 openid 在映射表中都指向"张三"，pi 即可知道是同一人。）

未命中时退回自动行为：QQ 返回了昵称则显示昵称，否则只显示 openid 前 12 位。

## 文件位置与格式

```
~/.pi/agent/qq-integration/aliases.json
```

```json
{
  "version": 1,
  "aliases": {
    "AbCdEf1234567890abcd（私聊 user_openid）": "张三",
    "Xy98wV76tu52mn34op67（A群 member_openid）": "张三",
    "Mn10Lk09ji78gh56de12（B群 member_openid）": "李四"
  }
}
```

- key = **完整** openid，value = 别名（1~32 字符，同一别名可对应多行）
- **直接编辑文件即可**：改动即时生效（mtime 热重载），无需重启 pi
- 该文件被所有 pi 实例（leader/follower）共享

## 获取 openid

openids 的完整值出现在 pi 的集成日志中：

```
~/.pi/agent/qq-integration.log
```

搜索 `openid:` 可找到转发消息时记录的前缀；日志中前缀只含 openid **前 12 位**，完整值可在日志的 debug 行（`收到 QQ 消息` 相关条目）中找到。也可以直接把消息原文发给 pi，让其引用前缀中的 openid 片段配合 `/qq-alias set <前缀>` 使用。

## pi 端命令（/qq-alias）

| 命令 | 说明 |
|------|------|
| `/qq-alias list` | 列出全部映射（按别名排序） |
| `/qq-alias set <openid或唯一前缀> <别名>` | 新增/更新。入参支持完整 openid 或**已有条目的唯一前缀**（前缀需无歧义命中唯一条目） |
| `/qq-alias del <openid或唯一前缀>` | 删除。前缀命中多条时报错并列出候选 |

示例：

```
/qq-alias set AbCdEf1234567890abcd 张三      # 完整 openid，新增或更新
/qq-alias set AbCdEf12 李四                  # 前缀命中已有条目，改别名
/qq-alias del AbCdEf12                       # 删除
```

**注意**：`set` 的前缀匹配只作用于**已存在**的条目。要给一个全新的 openid（比如张三在 B 群的 member_openid）登记别名，需要提供完整 openid；如果该 openid 已在表中，用前缀即可修改。

**半自动认领（自动提示）**：遇到未登记的用户时，扩展会在**首次**转发的消息末尾自动附加一行提示（每个 openid 每次运行只提示一次，不刷屏）：

```
[提示: 该发送者尚未登记别名，完整 openid: XXXX…。可在 pi 终端执行 /qq-alias set XXXX <别名> 登记，或让模型引导用户完成]
```

pi 看到提示后会主动询问对方身份并引导你完成登记；openid 完整值可直接从提示中复制。

## 安全与边界

- 别名会被注入发送给 pi 的消息前缀，控制字符会被自动剔除，长度截断到 32 字符
- 文件解析失败时按空表处理，不会影响消息转发主流程
- 映射条目上限 1000 条
- 同一 openid 在不同群有不同的 member_openid：同一个人在几个群活跃，就需要登记几行（这是 QQ 平台的 openid 机制决定的，无法绕过）
