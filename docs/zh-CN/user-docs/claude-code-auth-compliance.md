# Claude Code 认证合规性研究

日期：2026-04-10

## 执行摘要

Anthropic 当前公开的指导原则边界非常清晰：

- Anthropic 自家的原生应用，包括 Claude Code，可以使用 Claude 订阅认证。
- 第三方工具应优先通过 Claude Console 或受支持云 provider 的 API key 进行认证。
- 任何伪装身份、绕过订阅限制转发第三方流量、或以其他方式违反 Anthropic 条款的应用，都被明确禁止。

对于 GSD2，安全路径应当是：

1. 把本地 Claude Code 视为一个外部、已认证的运行时。
2. 永远不要让 GSD 用户通过 GSD 托管的 Anthropic OAuth 去登录 Claude 订阅。
3. 永远不要把 Claude.ai 的订阅 OAuth 凭据交换成 bearer token，然后冒充 Claude Code 直接调用 Anthropic API。
4. 如果 GSD 需要直接访问 Anthropic API，则必须要求使用 Claude Console API key、Bedrock、Vertex 或其他被明确支持的 provider 路径。

## Anthropic 明确允许的内容

### 1. Claude Code 本身可以使用 Claude 订阅认证

Anthropic 帮助中心说明：Claude Pro / Max 用户应安装 Claude Code，运行 `claude`，并“使用与你登录 Claude 相同的凭据”完成登录。文档还指出，这样会把订阅直接连接到 Claude Code，并且 `/login` 是切换账户类型的方式。Team / Enterprise 文章对组织账号也给出了同样流程。

对 GSD2 的含义：

- 允许用户在真正的 `claude` CLI 内部完成认证，是符合 Anthropic 文档流程的
- 检测 `claude auth status`，然后通过本地 CLI 或官方 Claude Code SDK 路由工作，是风险最低的方案

### 2. Claude Code 同时支持订阅 OAuth 和 API 凭据

Anthropic 的 Claude Code 文档说明，支持的认证类型包括 Claude.ai 凭据、Claude API 凭据、Azure Auth、Bedrock Auth 和 Vertex Auth。文档还定义了认证优先级：

1. cloud provider 凭据
2. `ANTHROPIC_AUTH_TOKEN`
3. `ANTHROPIC_API_KEY`
4. `apiKeyHelper`
5. 来自 `/login` 的订阅 OAuth

对 GSD2 的含义：

- 如果 GSD2 是通过 shell 调用或嵌入 Claude Code，那么它应尊重 Claude Code 自己的凭据选择逻辑，而不是再发明一套平行的 Anthropic OAuth 流程
- 对需要动态短期凭据、但又不希望把原始 API key 交给工具的组织来说，`apiKeyHelper` 是一个干净的企业级出口

### 3. Anthropic 的商业使用可通过 API keys 和受支持的云 provider 实现

Anthropic 的商业条款约束的是 API keys 及其相关 Anthropic 服务，包括供客户构建给终端用户使用的产品。面向团队的认证文档推荐使用 Claude for Teams / Enterprise、Claude Console、Bedrock、Vertex 或 Microsoft Foundry。

对 GSD2 的含义：

- 如果 GSD2 作为一个产品面向用户提供 Anthropic 能力，那么任何直接 Anthropic 访问都应走商业认证路径，而不是复用订阅 token

## Anthropic 明确警告的内容

Anthropic 当前的 “Logging in to your Claude account” 文章给出了最清晰的表述：

- 订阅计划仅适用于 Anthropic 原生应用的日常使用，包括 Claude Web、桌面端、移动端和 Claude Code
- 对第三方工具（包括开源项目），“首选方式”是通过 Claude Console 或受支持云 provider 的 API key 认证
- 如果你正在为他人构建产品、应用或工具，应使用 Claude Console API key 或受支持云 provider 的认证方式
- 任何伪装身份、绕过订阅限制转发第三方流量、或以其他方式违反条款的工具，都被禁止

Anthropic 的消费条款还额外加入两项限制：

- 用户不得把账户登录信息、API keys 或账户凭据分享给他人
- 除非是通过 Anthropic API key 访问服务，或者 Anthropic 明确允许，否则用户不得通过自动化或非人工方式访问这些服务

对 GSD2 的含义：

- 由 GSD 托管的 Anthropic 订阅 OAuth 流程属于高风险
- 在 GSD 自己的 API client 中复用用户 Claude 订阅凭据属于高风险
- 任何会让 Anthropic 误以为请求来自 Claude Code、但实际上来自 GSD 基础设施的流程，都越界了

## 当前 GSD2 发现

### 低风险 / 已对齐的部分

- `src/resources/extensions/claude-code-cli/index.ts`
  把 `claude-code` 注册成 `externalCli` provider，并通过 Anthropic 官方的 `@anthropic-ai/claude-agent-sdk` 路由
- `src/resources/extensions/claude-code-cli/readiness.ts`
  只通过 `claude --version` 和 `claude auth status` 检查本地 CLI 是否存在以及认证状态
- `src/onboarding.ts`
  TUI onboarding 已移除 Anthropic 浏览器 OAuth，并把本地 Claude Code 路由标记为符合 TOS 的路径
- `src/cli.ts`
  当检测到本地 CLI 可用时，会把用户从 `anthropic` 迁移到 `claude-code`

这些方向是正确的，因为此时 GSD 使用的是用户自己本地安装的 Claude Code，作为已认证的 Anthropic surface。

### 中高风险部分 —— 已解决

所有 Anthropic OAuth 代码路径都已被移除：

- `packages/pi-ai/src/utils/oauth/anthropic.ts` —— **已删除**，不再实现 Anthropic OAuth 流程
- `packages/pi-ai/src/utils/oauth/index.ts` —— **已更新**，内置注册表中移除了 `anthropicOAuthProvider`
- `src/web/onboarding-service.ts` —— **已更新**，将 Anthropic 标记为 `supportsOAuth: false`
- `packages/daemon/src/orchestrator.ts` —— **已更新**，去掉 OAuth token refresh，改为要求 `ANTHROPIC_API_KEY` 环境变量
- `packages/pi-ai/src/providers/anthropic.ts` —— **已更新**，移除 OAuth client 分支，`isOAuthToken` 始终返回 false

## 针对 GSD2 的建议策略

将下面内容作为仓库规则：

- Claude 订阅认证只允许存在于 Anthropic 自有 surface 中：
  - `claude` CLI
  - 基于本地已认证 Claude Code 安装的 Claude Code SDK
  - 其他 Anthropic 文档明确支持的原生流程
- GSD2 不得为终端用户实现自己的 Anthropic 订阅 OAuth 流程
- GSD2 不得持久化 Anthropic 订阅 OAuth token，供后续 API 调用使用
- GSD2 不得使用由 GSD 获取的订阅 OAuth tokens 来发送 Anthropic API 流量
- GSD2 可以支持 Anthropic 直接访问，但仅限以下方式：
  - `ANTHROPIC_API_KEY`
  - 保存在 auth storage 中的 Claude Console API keys
  - `apiKeyHelper`
  - Bedrock / Vertex / Foundry
  - 本地 Claude Code provider

## 推荐实现方案

### 方案 A：安全的最小合规清理

1. 从内置 OAuth provider 注册表中移除 Anthropic
2. 把 Web onboarding 中的 Anthropic 改为只支持 API key
3. 当 `claude auth status` 成功时，继续保留 `claude-code` 作为推荐路径
4. 增加明确的 UI 文案：
   - “Claude 订阅用户：请登录本地 Claude Code app / CLI，而不是 GSD。”
5. 阻止任何把 Anthropic OAuth 凭据转换成 GSD 托管请求 API 认证的迁移或代码路径

这是让仓库与 Anthropic 当前公开指导对齐的最快路径。

### 方案 B：企业级安全的 Anthropic 支持

把 Anthropic 支持拆分成三种清晰模式：

- `claude-code`
  只使用本地已认证的 `claude` 运行时
- `anthropic-api`
  使用 Console API keys 或 `apiKeyHelper`
- `anthropic-cloud`
  使用 Bedrock、Vertex 或 Foundry

然后彻底移除任何模糊的 `anthropic` 浏览器登录路径。

这是长期最好的 UX，因为它清晰地区分了：

- 基于订阅的原生使用
- 基于 API 计费的使用
- 通过云路由的使用

## 具体仓库后续动作 —— 已完成

1. ~~删除或禁用 `packages/pi-ai/src/utils/oauth/anthropic.ts`。~~ **已完成** —— 文件已删除
2. ~~从 `packages/pi-ai/src/utils/oauth/index.ts` 中移除 `anthropicOAuthProvider`。~~ **已完成**
3. ~~修改 `src/web/onboarding-service.ts`，让 Anthropic 不再声称支持 OAuth。~~ **已完成**
4. ~~审查 `packages/daemon/src/orchestrator.ts` 以及其他把 Anthropic OAuth access token 当作 API 凭据使用的调用方。~~ **已完成** —— daemon 现在要求 `ANTHROPIC_API_KEY`
5. ~~更新文档 / UI 文案：直接 API 使用优先 `anthropic-api`，订阅使用优先 `claude-code`。~~ **已完成** —— `providers.md` 和 `getting-started.md` 已更新
6. 添加测试，防止 Anthropic 订阅 OAuth 通过 onboarding / provider registry 被重新引入 —— **TODO**

## 决策规则

如果某个拟议中的 GSD2 特性需要访问 Anthropic，先问一个问题：

“GSD 是以 GSD 的身份调用 Anthropic，还是 GSD 只是把工作委派给用户本地已认证的 Claude Code 运行时？”

- 如果 GSD 是以 GSD 的身份调用 Anthropic：必须要求 API key 或受支持的云认证
- 如果 GSD 只是委派给本地 Claude Code：可以接受，前提是 GSD 自身不会拦截、生成或重放订阅凭据

## 审查过的来源

- Anthropic Help Center: “Logging in to your Claude account”
- Anthropic Help Center: “Using Claude Code with your Pro or Max plan”
- Anthropic Help Center: “Use Claude Code with your Team or Enterprise plan”
- Anthropic Help Center: “Managing API key environment variables in Claude Code”
- Anthropic Help Center: “API Key Best Practices: Keeping Your Keys Safe and Secure”
- Claude Code Docs：getting started / authentication / team / settings / IAM
- Anthropic Commercial Terms of Service
- Anthropic Consumer Terms of Service
- Anthropic Usage Policy
