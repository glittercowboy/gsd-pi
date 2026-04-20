# 远程提问

在无头自动模式下运行时，远程提问允许 GSD 通过 Slack、Discord 或 Telegram 请求用户输入。当 GSD 遇到需要人工判断的决策点时，它会把问题发到你配置好的频道，并轮询等待响应。

## 设置

### Discord

```
/gsd remote discord
```

配置向导会：

1. 询问你的 Discord bot token
2. 通过 Discord API 验证该 token
3. 列出 bot 当前加入的服务器（或让你选择）
4. 列出所选服务器中的文本频道
5. 发送一条测试消息以确认权限
6. 把配置保存到 `~/.gsd/PREFERENCES.md`

**Bot 要求：**

- 需要一个带 token 的 Discord bot application（来自 [Discord Developer Portal](https://discord.com/developers/applications)）
- Bot 必须以以下权限加入目标服务器：
  - Send Messages
  - Read Message History
  - Add Reactions
  - View Channel
- 必须设置 `DISCORD_BOT_TOKEN` 环境变量（配置向导会帮你处理）

### Slack

```
/gsd remote slack
```

配置向导会：

1. 询问你的 Slack bot token（`xoxb-...`）
2. 验证该 token
3. 列出 bot 可访问的频道（也支持手动输入 ID）
4. 发送一条测试消息确认权限
5. 保存配置

**Bot 要求：**

- 需要一个带 bot token 的 Slack app（来自 [Slack API](https://api.slack.com/apps)）
- Bot 必须已加入目标频道
- 公共 / 私有频道常见需要的 scope：`chat:write`、`reactions:read`、`reactions:write`、`channels:read`、`groups:read`、`channels:history`、`groups:history`

### Telegram

```
/gsd remote telegram
```

配置向导会：

1. 询问你的 Telegram bot token（来自 [@BotFather](https://t.me/BotFather)）
2. 通过 Telegram API 验证该 token
3. 询问 chat ID（群聊或私聊）
4. 发送测试消息以确认权限
5. 保存配置

**Bot 要求：**

- 需要一个来自 [@BotFather](https://t.me/BotFather) 的 Telegram bot token
- Bot 必须已加入目标群聊（或者直接与 bot 私聊）
- 必须设置 `TELEGRAM_BOT_TOKEN` 环境变量

## 配置

远程提问配置保存在 `~/.gsd/PREFERENCES.md`：

```yaml
remote_questions:
  channel: discord          # 或 slack 或 telegram
  channel_id: "1234567890123456789"
  timeout_minutes: 5        # 1-30，默认 5
  poll_interval_seconds: 5  # 2-30，默认 5
```

## 工作原理

1. GSD 在自动模式过程中遇到一个决策点
2. 问题会以富文本 embed（Discord）或 Block Kit 消息（Slack）的形式发送到你配置的频道
3. GSD 按设定的间隔轮询响应
4. 你可以通过以下方式回复：
   - **添加数字表情回应**（1️⃣、2️⃣ 等），适用于单问题提示
   - **回复消息内容**，可以是数字（`1`）、逗号分隔数字（`1,3`）或自由文本
5. GSD 读取到响应后继续执行
6. 提示消息上会追加一个 ✅ 反应，表示已收到

### 响应格式

**单个问题：**

- 用数字表情回应（适用于单问题提示）
- 回复一个数字：`2`
- 回复自由文本（会作为用户备注记录）

**多个问题：**

- 用分号回复：`1;2;custom text`
- 用换行回复（每行一个答案）

### 超时

如果在 `timeout_minutes` 内没有收到响应，提示会超时，GSD 将带着超时结果继续执行。LLM 会根据当前上下文处理超时，通常是做一个保守默认选择，或者暂停自动模式。

## 命令

| 命令 | 说明 |
|------|------|
| `/gsd remote` | 显示远程提问菜单和当前状态 |
| `/gsd remote slack` | 配置 Slack 集成 |
| `/gsd remote discord` | 配置 Discord 集成 |
| `/gsd remote status` | 显示当前配置和最近一次提示状态 |
| `/gsd remote disconnect` | 移除远程提问配置 |

## Discord 与 Slack 功能对比

| 功能 | Discord | Slack |
|------|---------|-------|
| 富文本消息格式 | Embeds with fields | Block Kit |
| 用 reaction 回答 | ✅（单问题） | ✅（单问题） |
| 线程式回复 | Message replies | Thread replies |
| 日志中的消息 URL | ✅ | ✅ |
| 已收到应答的确认 | ✅ 收到后加 reaction | ✅ 收到后加 reaction |
| 多问题支持 | 文本回复（分号 / 换行） | 文本回复（分号 / 换行） |
| 提示中的上下文来源 | ✅（footer） | ✅（context block） |
| 服务器 / 频道选择器 | ✅（交互式） | ✅（交互式 + 手动兜底） |
| Token 验证 | ✅ | ✅ |
| 配置阶段测试消息 | ✅ | ✅ |

## 故障排查

### “Remote auth failed”

- 确认 bot token 正确且未过期
- 对 Discord：确认 bot 仍然在目标服务器内
- 对 Slack：确认 bot token 以 `xoxb-` 开头

### “Could not send to channel”

- 确认 bot 在目标频道拥有 Send Messages 权限
- 对 Discord：检查 Server Settings 中 bot 对应角色的权限
- 对 Slack：确认 bot 已加入频道（`/invite @botname`）

### 未检测到响应

- 确认你是在**回复该提示消息**，而不是单独发了一条新消息
- 对 reactions：只有单问题提示上的数字表情（1️⃣-5️⃣）会被识别
- 检查 `timeout_minutes` 是否足够长，能覆盖你的响应时间

### 频道 ID 格式

- **Slack**：9-12 位大写字母数字字符（例如 `C0123456789`）
- **Discord**：17-20 位纯数字 snowflake ID（例如 `1234567890123456789`）
- 在 Discord 中开启 Developer Mode（Settings → Advanced）后可以复制频道 ID
