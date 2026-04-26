# Hooks

Hooks 允许你在 GSD 生命周期中的特定节点执行 shell 命令，而不需要自己编写 TypeScript 扩展。它们通过 `settings.json` 中的 `hooks` 键进行配置。

## 配置

在全局设置 `~/.pi/agent/settings.json` 中添加一个 `hooks` 对象：

```json
{
  "hooks": {
    "PreToolUse": [
      { "match": { "tool": "bash" }, "command": "my-linter --stdin" }
    ],
    "PostToolUse": [
      { "match": { "tool": ["edit", "write"] }, "command": "prettier --write" }
    ],
    "Stop": [
      { "command": "notify-send 'GSD is done'" }
    ]
  }
}
```

每个 hook 本质上都是一条 shell 命令。GSD 会把事件负载以 JSON 形式写入该命令的 stdin。命令也可以通过 stdout 返回一个 JSON 对象，用来修改待执行的动作（见下方的 **控制协议**）。

### Hook 条目字段

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `command` | `string` | — | 要执行的 shell 命令 |
| `match` | object | — | 过滤条件：`{ tool?: string \| string[]; command?: string }` |
| `timeout` | `number` | 30000 | 超时时间，单位毫秒 |
| `blocking` | `boolean` | `true` | 为 `true` 时，非零退出码会否决当前待执行动作 |
| `env` | object | — | 额外注入的环境变量 |

子进程同时还会收到 `GSD_HOOK_EVENT` 和 `GSD_HOOK_SCOPE` 两个环境变量。

## 可用 hooks

| 名称 | 触发时机 | 可阻塞 |
|------|----------|--------|
| `PreToolUse` | 每次工具调用之前 | 是 |
| `PostToolUse` | 每次工具调用之后 | 否 |
| `UserPromptSubmit` | 用户提交 prompt 时 | 是（通过 exit 1） |
| `SessionStart` | 会话开始时 | 否 |
| `SessionEnd` | 进程内会话结束时 | 否 |
| `Stop` | agent 进入真正静止状态时 | 否 |
| `Notification` | agent 发出通知时（blocked、idle 等） | 否 |
| `Blocked` | 尤其在 agent 因等待输入而阻塞时 | 否 |
| `PreCompact` | 上下文压缩前 | 是 |
| `PostCompact` | 上下文压缩后 | 否 |
| `PreCommit` | git commit 之前 | 是（可改写提交信息） |
| `PostCommit` | git commit 之后 | 否 |
| `PrePush` | git push 之前 | 是 |
| `PostPush` | git push 之后 | 否 |
| `PrePr` | PR 打开之前 | 是（可改写标题 / 正文） |
| `PostPr` | PR 打开之后 | 否 |
| `PreMilestone` | milestone 开始之前（自动构建） | 否 |
| `PostMilestone` | milestone 结束之后 | 否 |
| `PreUnit` | 单元开始之前 | 否 |
| `PostUnit` | 单元结束之后 | 否 |
| `PreVerify` | verification 运行之前 | 是 |
| `PostVerify` | verification 运行之后，负载里包含 `failures[]` | 否 |
| `BudgetThreshold` | 成本越过预算某个分数阈值时 | 是（可返回 `action`） |

## 控制协议

Hook 可以向 stdout 写入一个 JSON 对象，用来修改待执行动作。可用字段取决于 hook 类型：

```jsonc
// PreToolUse / UserPromptSubmit / PreCompact / PreVerify / PrePush / PreCommit
{ "block": true, "reason": "policy: no rm -rf" }

// PreCommit — 改写提交信息
{ "message": "feat(x): clarified intent" }

// PrePr — 改写标题和/或正文
{ "title": "...", "body": "..." }

// BudgetThreshold — 覆盖默认执行动作
{ "action": "pause" }   // 或 "downgrade" | "continue"
```

任何非 JSON 的 stdout 都会被忽略（也就是说，你仍然可以输出普通进度日志）。对于 `blocking: true` 的 hooks（默认就是如此），非零退出码会被视为阻塞。

## 项目级 hooks（信任模型）

声明在 `.pi/settings.json`（项目本地）中的 hooks，**默认不会执行，除非用户显式信任它们**。这样可以防止从别处 clone 下来的仓库在你的机器上随意执行 shell 命令。

如果要信任项目级 hooks，创建一个标记文件：

```shell
touch .pi/hooks.trusted
```

全局配置 `~/.pi/agent/settings.json` 中的 hooks 则总会执行，因为全局设置本来就在用户自己的控制之下。

## 示例：拦截危险的 bash 命令

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "match": { "tool": "bash" },
        "command": "jq -e '.input.command | test(\"rm -rf\")' > /dev/null && echo '{\"block\":true,\"reason\":\"rm -rf blocked by policy\"}' || true"
      }
    ]
  }
}
```

## 示例：提交前运行 lint

```json
{
  "hooks": {
    "PreCommit": [
      { "command": "eslint --fix $(jq -r '.files[]')" }
    ]
  }
}
```

## 示例：停止时发送通知

```json
{
  "hooks": {
    "Stop": [
      { "command": "terminal-notifier -title GSD -message 'Agent stopped'" }
    ]
  }
}
```

## Claude Code 兼容性

Hook 名称，以及基于 JSON stdin/stdout 的协议，都与 Claude Code 的 hooks 保持镜像兼容，因此大多数现有的 Claude Code hook 命令都可以直接拿来用。由于事件映射是一一对应的，你通常可以把 Claude Code `settings.json` 里的 hooks 配置块直接复制到 GSD 中，无需修改。
