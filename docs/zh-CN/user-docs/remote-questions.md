# 远程提问

在自动模式运行时，远程提问允许 GSD 通过 Slack、Discord 或 Telegram 请求用户输入，并发送信息型通知。当 GSD 遇到需要人工判断的决策点时，它会把问题发到你配置好的频道，并轮询等待响应。milestone 完成、阻塞、预算预警以及其他状态事件，也会被发送到同一个频道。

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

## 信息型通知

除了交互式提问之外，GSD 还会把自动模式中的关键事件作为信息型通知发送到你的远程频道。这些通知不需要回复，也不受桌面通知开关控制；只要已配置远程频道并触发相应事件，GSD 就会尝试发送。

会远程发送的事件包括：

| 事件 | 说明 |
|------|------|
| Milestone complete | 某个 milestone 已成功完成 |
| All milestones done | 整个 roadmap 已全部完成 |
| Blocker encountered | 自动模式因无法解决的问题而停止 |
| Budget alert | 花费正在接近，或已经到达配置的预算上限 |
| Budget ceiling reached | 因超过 `budget_ceiling`，自动模式已暂停 |

接收交互式提问的同一个远程频道也会接收这些状态事件，不需要额外配置。如果未配置远程频道，GSD 会跳过远程信息型通知。

## Telegram 命令

当 Telegram 被配置为远程频道时，GSD 会在自动模式运行期间启动空闲时后台轮询（大约每 5 秒一次）。这样你就可以直接在 Telegram 聊天里向 bot 发送命令，并获得实时项目状态反馈。

> **注意：** 后台命令轮询仅支持 Telegram。Slack 和 Discord 采用 webhook 模型，不支持从聊天窗口向 GSD 发送入站命令。

### 可用命令

所有命令响应都会带上项目名前缀（例如 `📁 MyProject`），这样在同时运行多个项目时也能区分来源。

| 命令 | 说明 | 示例响应 |
|------|------|----------|
| `/status` | 当前 milestone、活跃单元和当前会话成本 | `📁 MyProject — M001: Auth System · Executing S02/T03 · $1.24` |
| `/progress` | roadmap 概览，展示已完成和未完成的 milestones | `📁 MyProject — ✅ M001 Auth · 🔄 M002 Dashboard (active) · ⏳ M003 API` |
| `/budget` | 当前会话的 token 使用量和成本 | `📁 MyProject — Session: $2.18 · 142k tokens · ceiling: $50.00` |
| `/pause` | 在当前单元完成后暂停自动模式 | `📁 MyProject — Pause directive set. Auto-mode will stop after current unit.` |
| `/resume` | 清除暂停指令并继续自动模式 | `📁 MyProject — Pause directive cleared. Auto-mode will continue.` |
| `/log [n]` | 最近 `n` 条活动日志（默认 5） | `📁 MyProject — [10:42] Completed T02 · [10:38] Started T02 · ...` |
| `/help` | 列出所有可用命令 | `📁 MyProject — Available commands: /status /progress ...` |

### 后台轮询如何工作

当自动模式运行且没有进行中的远程提问提示时，GSD 会大约每 5 秒轮询一次 Telegram Bot API，拉取发给 bot 的新消息。收到命令后，GSD 会处理该命令，并在同一个聊天中回复。若当前正在等待 Telegram 远程提问的答案，命令会由该提示的轮询循环处理，而不是由后台轮询循环处理。

轮询只会在自动模式运行期间启用。当自动模式停止时（无论正常结束，还是通过 `/pause` 暂停），轮询也会一起停止。再次执行 `/gsd auto` 启动或恢复自动模式时，轮询会自动恢复。

`/pause` 会设置一个停止指令，GSD 会在每个单元边界检查它，因此当前单元总会先完成，然后自动模式才会停下。若自动模式仍在运行且尚未到达该边界，`/resume` 会清除该指令，让自动模式在无需终端交互的情况下继续运行；若自动模式已经停止，请在终端执行 `/gsd auto` 恢复。

## 命令

| 命令 | 说明 |
|------|------|
| `/gsd remote` | 显示远程提问菜单和当前状态 |
| `/gsd remote slack` | 配置 Slack 集成 |
| `/gsd remote discord` | 配置 Discord 集成 |
| `/gsd remote telegram` | 配置 Telegram 集成 |
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
| 信息型通知 | ✅ | ✅ |
| 后台命令轮询 | ❌ | ❌ |

Telegram 还支持以上全部能力，并额外提供后台命令轮询（`/status`、`/pause`、`/resume` 等）。

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

### Telegram 命令没有响应

- 确认自动模式当前正在运行，后台轮询只会在自动模式活动期间启用
- 确认 `~/.gsd/PREFERENCES.md` 中的 bot token 与 [@BotFather](https://t.me/BotFather) 提供的 token 一致
- 确认配置中的 `chat_id`（或 `channel_id`）和你发送命令的聊天一致，bot 只会在其配置的聊天中响应
- 先发送 `/help`；如果 bot 有回复，说明轮询正常，问题可能只出在某个具体命令
- 在终端执行 `/gsd remote status`，确认 Telegram 配置已经被正确保存
