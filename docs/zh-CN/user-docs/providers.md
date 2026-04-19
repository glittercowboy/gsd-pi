# Provider 设置指南

这是一份覆盖 GSD 所有受支持 LLM providers 的分步配置指南。如果你已经运行过 onboarding 向导（`gsd config`）并选择了 provider，很可能已经配置完成，可以在会话中用 `/model` 检查。

## 目录

- [快速参考](#quick-reference)
- [内置 Providers](#built-in-providers)
  - [Anthropic（Claude）](#anthropic-claude)
  - [OpenAI](#openai)
  - [Google Gemini](#google-gemini)
  - [OpenRouter](#openrouter)
  - [Groq](#groq)
  - [xAI（Grok）](#xai-grok)
  - [Mistral](#mistral)
  - [GitHub Copilot](#github-copilot)
  - [Amazon Bedrock](#amazon-bedrock)
  - [Vertex AI 上的 Anthropic](#anthropic-on-vertex-ai)
  - [Azure OpenAI](#azure-openai)
- [本地 Providers](#local-providers)
  - [Ollama](#ollama)
  - [LM Studio](#lm-studio)
  - [vLLM](#vllm)
  - [SGLang](#sglang)
- [自定义 OpenAI-Compatible Endpoints](#custom-openai-compatible-endpoints)
- [常见坑点](#common-pitfalls)
- [验证你的配置](#verifying-your-setup)

<a id="quick-reference"></a>
## 快速参考

| Provider | 认证方式 | 环境变量 | 配置文件 |
|----------|----------|----------|----------|
| Anthropic | API key | `ANTHROPIC_API_KEY` | — |
| OpenAI | API key | `OPENAI_API_KEY` | — |
| Google Gemini | API key | `GEMINI_API_KEY` | — |
| OpenRouter | API key | `OPENROUTER_API_KEY` | 可选 `models.json` |
| Groq | API key | `GROQ_API_KEY` | — |
| xAI | API key | `XAI_API_KEY` | — |
| Mistral | API key | `MISTRAL_API_KEY` | — |
| GitHub Copilot | OAuth | `GH_TOKEN` | — |
| Amazon Bedrock | IAM credentials | `AWS_PROFILE` 或 `AWS_ACCESS_KEY_ID` | — |
| Vertex AI | ADC | `GOOGLE_APPLICATION_CREDENTIALS` | — |
| Azure OpenAI | API key | `AZURE_OPENAI_API_KEY` | — |
| Ollama | 无（本地） | — | 需要 `models.json` |
| LM Studio | 无（本地） | — | 需要 `models.json` |
| vLLM / SGLang | 无（本地） | — | 需要 `models.json` |

---

<a id="built-in-providers"></a>
## 内置 Providers

内置 providers 的 models 已经预注册在 GSD 里。你只需要提供认证信息。

<a id="anthropic-claude"></a>
### Anthropic（Claude）

**推荐。** Anthropic models 集成最深，支持内置 Web 搜索、extended thinking 和 prompt caching。

**选项 A：API key（推荐）**

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

或者运行 `gsd config`，在提示时粘贴 key。

**获取 key：** [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)

**选项 B：Claude Code CLI**

如果你有 Claude Pro 或 Max 订阅，可以通过 Anthropic 官方的 Claude Code CLI 完成认证。安装后执行 `claude` 登录，随后 GSD 会自动检测并经由该通道路由：

```bash
# 安装 Claude Code CLI（见 https://docs.anthropic.com/en/docs/claude-code）
claude
# 按提示登录，然后启动 GSD
gsd
```

GSD 会检测你本地的 Claude Code 安装，并把它作为已认证的 Anthropic surface 使用。这是 Anthropic 订阅用户符合 TOS 的方式，GSD 不会直接处理你的订阅凭据。

> **注意：** GSD 不支持 Anthropic 的浏览器 OAuth 登录。请改用 API key 或 Claude Code CLI。

**选项 C：在 Claude Code 里直接用 Claude Pro / Max 订阅跑 GSD**

如果你已经有 Claude Pro / Max 订阅，并希望直接在 Claude Code 里使用 GSD 的 planning、execution 和 milestone orchestration，而不是切到单独终端，那么可以把 GSD 接成一个 MCP server。这样 Claude Code 就能通过 [Model Context Protocol](https://modelcontextprotocol.io) 使用 GSD 的完整 workflow 工具集，在你现有 Claude plan 的驱动下获得 GSD 的结构化项目管理能力。

**自动配置（推荐）**

当 GSD 在启动时检测到 Claude Code model，它会自动在项目根目录写入一个带有 GSD workflow MCP server 配置的 `.mcp.json` 文件。无需手动步骤，只要以 Claude Code 作为 provider 启动一次 GSD，配置就会自动生成。

你也可以在 GSD 会话中手动触发：

```bash
/gsd mcp init
```

这会在项目的 `.mcp.json` 中写入（或更新）`gsd-workflow` 条目。Claude Code 会在下一次启动会话时自动发现这个文件。

**手动配置**

如果你更希望自己配置，可以把 GSD 加到项目的 `.mcp.json` 中：

```json
{
  "mcpServers": {
    "gsd": {
      "command": "npx",
      "args": ["gsd-mcp-server"],
      "env": {
        "GSD_CLI_PATH": "/path/to/gsd"
      }
    }
  }
}
```

如果 `gsd-mcp-server` 已经全局安装：

```json
{
  "mcpServers": {
    "gsd": {
      "command": "gsd-mcp-server"
    }
  }
}
```

你也可以把这段配置写到 `~/.claude/settings.json` 的 `mcpServers` 中，让 GSD 在所有项目中都可用。

**暴露了什么**

MCP server 会暴露 GSD 的完整 workflow 工具面：milestone planning、task completion、slice 管理、roadmap reassessment、journal 查询等。会话管理工具（`gsd_execute`、`gsd_status`、`gsd_result`、`gsd_cancel`）允许 Claude Code 启动并监控 GSD 自动模式会话。完整工具列表见 [命令 → MCP Server 模式](./commands.md#mcp-server-mode)。

**验证连接**

在 GSD 会话里检查 MCP server 是否可达：

```bash
/gsd mcp status
```

<a id="openai"></a>
### OpenAI

```bash
export OPENAI_API_KEY="sk-..."
```

或者运行 `gsd config`，选择 “Paste an API key” 然后选择 “OpenAI”。

**获取 key：** [platform.openai.com/api-keys](https://platform.openai.com/api-keys)

<a id="google-gemini"></a>
### Google Gemini

```bash
export GEMINI_API_KEY="..."
```

**获取 key：** [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)

<a id="openrouter"></a>
### OpenRouter

OpenRouter 通过单个 API key 聚合了多个 providers 的 200+ models。

**第 1 步：获取 API key**

访问 [openrouter.ai/keys](https://openrouter.ai/keys) 创建一个 key。

**第 2 步：设置 key**

```bash
export OPENROUTER_API_KEY="sk-or-..."
```

或者运行 `gsd config`，选择 “Paste an API key” 然后选择 “OpenRouter”。

**第 3 步：切换到 OpenRouter model**

在 GSD 会话中输入 `/model` 并选择一个 OpenRouter model。OpenRouter models 都以 `openrouter/` 为前缀（例如 `openrouter/anthropic/claude-sonnet-4`）。

**可选：通过 `models.json` 添加自定义 OpenRouter models**

如果你想使用不在内置列表中的 model，可把它写进 `~/.gsd/agent/models.json`：

```json
{
  "providers": {
    "openrouter": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "OPENROUTER_API_KEY",
      "api": "openai-completions",
      "models": [
        {
          "id": "meta-llama/llama-3.3-70b",
          "name": "Llama 3.3 70B (OpenRouter)",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 131072,
          "maxTokens": 32768,
          "cost": { "input": 0.3, "output": 0.3, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

注意：这里的 `apiKey` 字段写的是**环境变量名**，不是字面 key。GSD 会自动解析它。你也可以改用字面值或 shell 命令（见 [值解析](./custom-models.md#value-resolution)）。

**可选：路由到指定上游 provider**

你可以通过 `modelOverrides` 控制 OpenRouter 实际选用哪个上游 provider：

```json
{
  "providers": {
    "openrouter": {
      "modelOverrides": {
        "anthropic/claude-sonnet-4": {
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

<a id="groq"></a>
### Groq

```bash
export GROQ_API_KEY="gsk_..."
```

**获取 key：** [console.groq.com/keys](https://console.groq.com/keys)

<a id="xai-grok"></a>
### xAI（Grok）

```bash
export XAI_API_KEY="xai-..."
```

**获取 key：** [console.x.ai](https://console.x.ai)

<a id="mistral"></a>
### Mistral

```bash
export MISTRAL_API_KEY="..."
```

**获取 key：** [console.mistral.ai/api-keys](https://console.mistral.ai/api-keys)

<a id="github-copilot"></a>
### GitHub Copilot

使用 OAuth，通过浏览器登录：

```bash
gsd config
# 选择 "Sign in with your browser" → "GitHub Copilot"
```

要求你拥有有效的 GitHub Copilot 订阅。

<a id="amazon-bedrock"></a>
### Amazon Bedrock

Bedrock 使用 AWS IAM 凭据，而不是 API key。下面任意一种都可以：

```bash
# 选项 1：命名 profile
export AWS_PROFILE="my-profile"

# 选项 2：IAM keys
export AWS_ACCESS_KEY_ID="AKIA..."
export AWS_SECRET_ACCESS_KEY="..."
export AWS_REGION="us-east-1"

# 选项 3：Bedrock API key（bearer token）
export AWS_BEARER_TOKEN_BEDROCK="..."
```

ECS task roles 和 IRSA（Kubernetes）也会被自动检测。

<a id="anthropic-on-vertex-ai"></a>
### Vertex AI 上的 Anthropic

使用 Google Cloud Application Default Credentials：

```bash
gcloud auth application-default login
export ANTHROPIC_VERTEX_PROJECT_ID="my-project-id"
```

或者设置 `GOOGLE_CLOUD_PROJECT`，并确保 ADC 凭据存在于 `~/.config/gcloud/application_default_credentials.json`。

<a id="azure-openai"></a>
### Azure OpenAI

```bash
export AZURE_OPENAI_API_KEY="..."
```

---

<a id="local-providers"></a>
## 本地 Providers

本地 providers 运行在你的机器上。因为 GSD 需要知道 endpoint URL 和可用 models，所以它们都要求配置 `models.json`。

**配置文件位置：** `~/.gsd/agent/models.json`

每次打开 `/model` 时，这个文件都会自动重新加载，无需重启。

<a id="ollama"></a>
### Ollama

**第 1 步：安装并启动 Ollama**

```bash
# macOS
brew install ollama
ollama serve

# 或前往 https://ollama.com 下载
```

**第 2 步：拉取一个 model**

```bash
ollama pull llama3.1:8b
ollama pull qwen2.5-coder:7b
```

**第 3 步：创建 `~/.gsd/agent/models.json`**

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
        { "id": "llama3.1:8b" },
        { "id": "qwen2.5-coder:7b" }
      ]
    }
  }
}
```

`apiKey` 是 schema 的必填字段，但 Ollama 会忽略它，因此任意值都可以。

**第 4 步：选择 model**

在 GSD 里输入 `/model`，然后选择你的 Ollama model。

**Ollama 提示：**

- Ollama 不支持 `developer` role，也不支持 `reasoning_effort`，因此请始终设置 `compat.supportsDeveloperRole: false` 和 `compat.supportsReasoningEffort: false`
- 如果得到空响应，先检查 `ollama serve` 是否正在运行，以及 model 是否已经 pull 下来
- 如果未显式指定，`contextWindow` 和 `maxTokens` 默认分别为 128K / 16K。若模型能力不同，请手动覆盖

<a id="lm-studio"></a>
### LM Studio

**第 1 步：安装 LM Studio**

访问 [lmstudio.ai](https://lmstudio.ai) 下载。

**第 2 步：启动本地 server**

在 LM Studio 中进入 “Local Server” 标签页，加载一个 model，然后点击 “Start Server”。默认端口为 1234。

**第 3 步：创建 `~/.gsd/agent/models.json`**

```json
{
  "providers": {
    "lm-studio": {
      "baseUrl": "http://localhost:1234/v1",
      "api": "openai-completions",
      "apiKey": "lm-studio",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        {
          "id": "your-model-name",
          "name": "My Local Model",
          "contextWindow": 32768,
          "maxTokens": 4096
        }
      ]
    }
  }
}
```

把 `your-model-name` 替换成 LM Studio server 标签页中显示的 model 标识符。

**LM Studio 提示：**

- `models.json` 里的 model `id` 必须与 LM Studio server API 返回的值完全一致
- LM Studio 默认端口是 1234；如果你改了端口，也要同步修改 `baseUrl`
- 如果模型支持更大的上下文，记得上调 `contextWindow` 和 `maxTokens`

<a id="vllm"></a>
### vLLM

```json
{
  "providers": {
    "vllm": {
      "baseUrl": "http://localhost:8000/v1",
      "api": "openai-completions",
      "apiKey": "vllm",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "supportsUsageInStreaming": false
      },
      "models": [
        {
          "id": "meta-llama/Llama-3.1-8B-Instruct",
          "contextWindow": 128000,
          "maxTokens": 16384
        }
      ]
    }
  }
}
```

model `id` 必须与 `vllm serve` 启动时传入的 `--model` 参数完全一致。

<a id="sglang"></a>
### SGLang

```json
{
  "providers": {
    "sglang": {
      "baseUrl": "http://localhost:30000/v1",
      "api": "openai-completions",
      "apiKey": "sglang",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        {
          "id": "meta-llama/Llama-3.1-8B-Instruct"
        }
      ]
    }
  }
}
```

---

<a id="custom-openai-compatible-endpoints"></a>
## 自定义 OpenAI-Compatible Endpoints

任何实现了 OpenAI Chat Completions API 的 server 都可以和 GSD 配合使用。这包括代理（LiteLLM、Portkey、Helicone）、自托管推理服务，以及新出现的 providers。

**最快路径：使用 onboarding 向导**

```bash
gsd config
# 选择 "Paste an API key" → "Custom (OpenAI-compatible)"
# 输入：base URL、API key、model ID
```

这会自动帮你写好 `~/.gsd/agent/models.json`。

**手动配置：**

```json
{
  "providers": {
    "my-provider": {
      "baseUrl": "https://my-endpoint.example.com/v1",
      "apiKey": "MY_PROVIDER_API_KEY",
      "api": "openai-completions",
      "models": [
        {
          "id": "model-id-here",
          "name": "Friendly Model Name",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 16384,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

**添加自定义 headers（常见于代理）**

```json
{
  "providers": {
    "litellm-proxy": {
      "baseUrl": "https://litellm.example.com/v1",
      "apiKey": "MY_API_KEY",
      "api": "openai-completions",
      "headers": {
        "x-custom-header": "value"
      },
      "models": [...]
    }
  }
}
```

**支持 thinking mode 的 Qwen models**

对于 Qwen-compatible servers，可用 `thinkingFormat` 打开 thinking mode：

```json
{
  "compat": {
    "thinkingFormat": "qwen",
    "supportsDeveloperRole": false
  }
}
```

如果该 server 要求 `chat_template_kwargs.enable_thinking`，请改用 `"qwen-chat-template"`。

关于 `compat` 字段、`modelOverrides`、值解析和高级配置的完整说明，见 [自定义模型](./custom-models.md)。

---

<a id="common-pitfalls"></a>
## 常见坑点

### 使用有效 key 仍提示 “Authentication failed”

**原因：** key 虽然设在 shell 中，但 GSD 看不到。

**解决：** 确认你是在同一个终端里 `export` 了该环境变量并运行 `gsd`。或者直接用 `gsd config` 把 key 保存进 `~/.gsd/agent/auth.json`，这样就能跨会话持久化。

### OpenRouter models 没出现在 `/model`

**原因：** 没有设置 `OPENROUTER_API_KEY`，因此 GSD 会隐藏 OpenRouter models。

**解决：** 设置 key 并重启 GSD：

```bash
export OPENROUTER_API_KEY="sk-or-..."
gsd
```

### Ollama 返回空响应

**原因：** Ollama server 没有运行，或者对应 model 尚未 pull。

**解决：**

```bash
# 确认 server 正在运行
curl http://localhost:11434/v1/models

# 如果 model 缺失则先 pull
ollama pull llama3.1:8b
```

### LM Studio model ID 不匹配

**原因：** `models.json` 中的 `id` 和 LM Studio 实际通过 API 暴露的值不一致。

**解决：** 去 LM Studio 的 server 标签页查看精确的 model 标识符。它通常会包含文件名或量化后缀（例如 `lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF`）。

### 本地 models 报 `developer` role 错误

**原因：** 大多数本地推理 server 不支持 OpenAI 的 `developer` message role。

**解决：** 在 provider 配置里添加 `compat.supportsDeveloperRole: false`。这样 GSD 会改用 `system` message：

```json
{
  "compat": {
    "supportsDeveloperRole": false,
    "supportsReasoningEffort": false
  }
}
```

### 本地 models 报 `stream_options` 错误

**原因：** 部分 server 不支持 `stream_options: { include_usage: true }`。

**解决：** 添加 `compat.supportsUsageInStreaming: false`：

```json
{
  "compat": {
    "supportsUsageInStreaming": false
  }
}
```

### 报 “apiKey is required” 校验错误

**原因：** `models.json` schema 规定：只要定义了 `models`，就必须存在 `apiKey`。

**解决：** 对于不需要认证的本地 server，填一个占位值即可：

```json
"apiKey": "not-needed"
```

### 自定义 models 的成本显示为 `$0.00`

这是**预期行为**。GSD 对自定义 models 的默认成本就是 0。如果你想获得准确的成本跟踪，需要自己填写 `cost` 字段：

```json
"cost": { "input": 0.15, "output": 0.60, "cacheRead": 0.015, "cacheWrite": 0.19 }
```

这些值的单位都是每百万 tokens。

---

<a id="verifying-your-setup"></a>
## 验证你的配置

完成 provider 配置后：

1. **启动 GSD：**
   ```bash
   gsd
   ```

2. **检查可用 models：**
   ```
   /model
   ```
   列表里应该能看到该 provider 的 models。

3. **切换到对应 model：**
   在 `/model` 选择器中选中它。

4. **发送一条测试消息：**
   输入任意内容，确认 model 可以正常响应。

如果 model 没有出现，请检查：

- 当前 shell 中是否设置了对应环境变量
- `models.json` 是否是合法 JSON（可执行 `cat ~/.gsd/agent/models.json | python3 -m json.tool`）
- 本地 providers 的 server 是否已经运行

如果还需要更多帮助，请查看 [故障排查](./troubleshooting.md)，或者在会话中运行 `/gsd doctor`。
