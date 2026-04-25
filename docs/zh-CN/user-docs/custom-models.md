# 自定义模型

通过 `~/.gsd/agent/models.json` 添加自定义 providers 和 models（Ollama、vLLM、LM Studio、代理等）。

## 目录

- [最小示例](#minimal-example)
- [完整示例](#full-example)
- [支持的 API](#supported-apis)
- [Provider 配置](#provider-configuration)
- [Model 配置](#model-configuration)
- [覆盖内置 Providers](#overriding-built-in-providers)
- [按 model 覆盖](#per-model-overrides)
- [OpenAI 兼容性](#openai-compatibility)

<a id="minimal-example"></a>
## 最小示例

对于本地 models（Ollama、LM Studio、vLLM），每个 model 只要求提供 `id`：

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        { "id": "llama3.1:8b" },
        { "id": "qwen2.5-coder:7b" }
      ]
    }
  }
}
```

`apiKey` 在 schema 中是必填，但 Ollama 会忽略它，因此任意值都可以。

有些 OpenAI-compatible server 不支持推理模型使用的 `developer` role。对于这类 provider，需要把 `compat.supportsDeveloperRole` 设为 `false`，这样 GSD 会改用 `system` message 发送 system prompt。如果该 server 同时也不支持 `reasoning_effort`，还应把 `compat.supportsReasoningEffort` 也设为 `false`。

你可以在 provider 级别设置 `compat`，让它应用到该 provider 下的所有 models；也可以在 model 级别单独覆盖某个 model。这个设置常见于 Ollama、vLLM、SGLang 以及类似的 OpenAI-compatible server。

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        {
          "id": "gpt-oss:20b",
          "reasoning": true
        }
      ]
    }
  }
}
```

<a id="full-example"></a>
## 完整示例

当你需要显式覆盖默认值时，可以写成更完整的配置：

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        {
          "id": "llama3.1:8b",
          "name": "Llama 3.1 8B (Local)",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 32000,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

每次打开 `/model` 时，这个文件都会重新加载。可以在会话过程中直接编辑，无需重启。

<a id="supported-apis"></a>
## 支持的 API

| API | 说明 |
|-----|------|
| `openai-completions` | OpenAI Chat Completions（兼容性最好） |
| `openai-responses` | OpenAI Responses API |
| `anthropic-messages` | Anthropic Messages API |
| `google-generative-ai` | Google Generative AI |

`api` 可以设置在 provider 级别（作为该 provider 下所有 models 的默认值），也可以设置在 model 级别（覆盖单个 model）。

<a id="provider-configuration"></a>
## Provider 配置

| 字段 | 说明 |
|------|------|
| `baseUrl` | API endpoint URL |
| `api` | API 类型（见上） |
| `apiKey` | API key（见下方值解析） |
| `headers` | 自定义请求头（见下方值解析） |
| `authHeader` | 设为 `true` 时，自动添加 `Authorization: Bearer <apiKey>` |
| `models` | model 配置数组 |
| `modelOverrides` | 针对该 provider 的内置 models 做按 model 覆盖 |

<a id="value-resolution"></a>
### 值解析

`apiKey` 和 `headers` 支持三种写法：

- **Shell 命令：** `"!command"`，执行后读取 stdout
  ```json
  "apiKey": "!security find-generic-password -ws 'anthropic'"
  "apiKey": "!op read 'op://vault/item/credential'"
  ```
- **环境变量：** 取对应环境变量的值
  ```json
  "apiKey": "MY_API_KEY"
  ```
- **字面量：** 直接使用
  ```json
  "apiKey": "sk-..."
  ```

<a id="command-allowlist"></a>
#### 命令允许列表

Shell 命令（`!command`）只能执行一组已知的凭据工具。只有以下前缀开头的命令才会被允许：

`pass`、`op`、`aws`、`gcloud`、`vault`、`security`、`gpg`、`bw`、`gopass`、`lpass`

不在列表中的命令会被阻止，最终该值会解析为 `undefined`。同时会向 stderr 输出一条警告。

为了防止注入，命令参数中的 shell 操作符（`;`、`|`、`&`、`` ` ``、`$`、`>`、`<`）同样会被阻止。

**自定义允许列表：**

如果你使用的凭据工具不在默认列表中，可以在全局设置（`~/.gsd/agent/settings.json`）里覆盖：

```json
{
  "allowedCommandPrefixes": ["pass", "op", "sops", "doppler", "mycli"]
}
```

这会完全替换默认列表，因此如果你还想保留默认命令，需要一起写进去。

你也可以设置 `GSD_ALLOWED_COMMAND_PREFIXES` 环境变量（逗号分隔）。环境变量优先级高于 settings.json：

```bash
export GSD_ALLOWED_COMMAND_PREFIXES="pass,op,sops,doppler"
```

> **注意：** 这是一个仅全局生效的设置。项目级 settings.json（`<project>/.gsd/settings.json`）不能覆盖命令 allowlist，以防克隆下来的仓库提升命令执行权限。

### 自定义 Headers

```json
{
  "providers": {
    "custom-proxy": {
      "baseUrl": "https://proxy.example.com/v1",
      "apiKey": "MY_API_KEY",
      "api": "anthropic-messages",
      "headers": {
        "x-portkey-api-key": "PORTKEY_API_KEY",
        "x-secret": "!op read 'op://vault/item/secret'"
      },
      "models": [...]
    }
  }
}
```

<a id="model-configuration"></a>
## Model 配置

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `id` | 是 | — | Model 标识符（会原样传给 API） |
| `name` | 否 | `id` | 可读的 model 标签，用于匹配（例如 `--model` 模糊匹配）并显示在详情 / 状态文字里 |
| `api` | 否 | provider 的 `api` | 为这个 model 覆盖 provider 的 API 类型 |
| `reasoning` | 否 | `false` | 是否支持扩展 thinking |
| `input` | 否 | `["text"]` | 输入类型：`["text"]` 或 `["text", "image"]` |
| `contextWindow` | 否 | `128000` | 上下文窗口大小（tokens） |
| `maxTokens` | 否 | `16384` | 最大输出 tokens |
| `cost` | 否 | 全为 0 | `{"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}`（每百万 tokens） |
| `compat` | 否 | provider 的 `compat` | OpenAI 兼容性覆盖项。如果 provider 和 model 两边都配置了，会合并 |

当前行为：

- `/model` 与 `--list-models` 都是按 model `id` 列出条目
- 配置里的 `name` 会用于 model 匹配，以及详情 / 状态文本展示

<a id="overriding-built-in-providers"></a>
## 覆盖内置 Providers

如果你想把某个内置 provider 经由代理路由出去，但又不想重新定义全部 models，可以这样写：

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "https://my-proxy.example.com/v1"
    }
  }
}
```

这样所有内置 Anthropic models 仍然可用。已有的 OAuth 或 API key 认证也会继续生效。

如果你想把自定义 models 合并进某个内置 provider，就同时提供 `models` 数组：

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "https://my-proxy.example.com/v1",
      "apiKey": "ANTHROPIC_API_KEY",
      "api": "anthropic-messages",
      "models": [...]
    }
  }
}
```

合并规则如下：

- 内置 models 会保留
- 自定义 models 会按 `id` 在该 provider 下执行 upsert
- 如果某个自定义 model 的 `id` 与内置 model 相同，自定义 model 会替换那个内置 model
- 如果某个自定义 model 的 `id` 是新的，它会作为新增条目并列出现

<a id="per-model-overrides"></a>
## 按 model 覆盖

如果你只想修改某些特定的内置 model，而不想替换整个 provider 的 model 列表，可以使用 `modelOverrides`。

```json
{
  "providers": {
    "openrouter": {
      "modelOverrides": {
        "anthropic/claude-sonnet-4": {
          "name": "Claude Sonnet 4 (Bedrock Route)",
          "compat": {
            "openRouterRouting": {
              "only": ["amazon-bedrock"]
            }
          }
        }
      }
    }
  }
}
```

`modelOverrides` 支持的字段包括：`name`、`reasoning`、`input`、`cost`（可部分覆盖）、`contextWindow`、`maxTokens`、`headers`、`compat`。

行为说明：

- `modelOverrides` 只会应用到内置 provider 的 models 上
- 未知的 model ID 会被忽略
- 可以把 provider 级别的 `baseUrl` / `headers` 与 `modelOverrides` 组合使用
- 如果某个 provider 同时定义了 `models`，那么自定义 models 会在应用完内置覆盖后再合并；如果它的 `id` 与已覆盖的内置 model 相同，最终会以自定义 model 为准

<a id="openai-compatibility"></a>
## OpenAI 兼容性

对于只部分兼容 OpenAI 的 providers，可通过 `compat` 字段修正行为。

- provider 级别的 `compat` 会作为该 provider 下所有 models 的默认值
- model 级别的 `compat` 会覆盖该 model 的 provider 级别设置

```json
{
  "providers": {
    "local-llm": {
      "baseUrl": "http://localhost:8080/v1",
      "api": "openai-completions",
      "compat": {
        "supportsUsageInStreaming": false,
        "maxTokensField": "max_tokens"
      },
      "models": [...]
    }
  }
}
```

| 字段 | 说明 |
|------|------|
| `supportsStore` | Provider 是否支持 `store` 字段 |
| `supportsDeveloperRole` | 是否使用 `developer` 而非 `system` role |
| `supportsReasoningEffort` | 是否支持 `reasoning_effort` 参数 |
| `reasoningEffortMap` | 把 GSD 的 thinking levels 映射到 provider 专属 `reasoning_effort` 值 |
| `supportsUsageInStreaming` | 是否支持 `stream_options: { include_usage: true }`（默认 `true`） |
| `maxTokensField` | 使用 `max_completion_tokens` 还是 `max_tokens` |
| `requiresToolResultName` | tool result message 中是否必须包含 `name` |
| `requiresAssistantAfterToolResult` | tool result 之后、user message 之前是否需要插入 assistant message |
| `requiresThinkingAsText` | 是否把 thinking block 转成纯文本 |
| `thinkingFormat` | 使用 `reasoning_effort`、`zai`、`qwen` 或 `qwen-chat-template` 的 thinking 参数格式 |
| `supportsStrictMode` | 是否在 tool definitions 中包含 `strict` 字段 |
| `openRouterRouting` | 传给 OpenRouter 的路由配置，用于 model/provider 选择 |
| `vercelGatewayRouting` | Vercel AI Gateway 的路由配置，用于 provider 选择（`only`、`order`） |

`qwen` 使用顶层 `enable_thinking`。对于要求 `chat_template_kwargs.enable_thinking` 的本地 Qwen-compatible server，请使用 `qwen-chat-template`。

示例：

```json
{
  "providers": {
    "openrouter": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "OPENROUTER_API_KEY",
      "api": "openai-completions",
      "models": [
        {
          "id": "openrouter/anthropic/claude-3.5-sonnet",
          "name": "OpenRouter Claude 3.5 Sonnet",
          "compat": {
            "openRouterRouting": {
              "order": ["anthropic"],
              "fallbacks": ["openai"]
            }
          }
        }
      ]
    }
  }
}
```

Vercel AI Gateway 示例：

```json
{
  "providers": {
    "vercel-ai-gateway": {
      "baseUrl": "https://ai-gateway.vercel.sh/v1",
      "apiKey": "AI_GATEWAY_API_KEY",
      "api": "openai-completions",
      "models": [
        {
          "id": "moonshotai/kimi-k2.5",
          "name": "Kimi K2.5 (Fireworks via Vercel)",
          "reasoning": true,
          "input": ["text", "image"],
          "cost": { "input": 0.6, "output": 3, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 262144,
          "maxTokens": 262144,
          "compat": {
            "vercelGatewayRouting": {
              "only": ["fireworks", "novita"],
              "order": ["fireworks", "novita"]
            }
          }
        }
      ]
    }
  }
}
```
