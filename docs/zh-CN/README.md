# GSD 文档

欢迎使用 GSD 文档。这里涵盖了从快速开始到高级配置、自动模式内部机制，以及如何基于 Pi SDK 扩展 GSD 的内容。

> 本目录是主文档的简体中文翻译。目前优先覆盖 `docs/user-docs/` 这套用户手册；如中英文内容有差异，请以英文原文为准。

## 用户文档

用于安装、配置和日常使用 GSD 的指南。文件位于 [`user-docs/`](./user-docs/)。

| 指南 | 说明 |
|------|------|
| [快速开始](./user-docs/getting-started.md) | 安装、首次运行和基础使用 |
| [自动模式](./user-docs/auto-mode.md) | 自主执行如何工作，包括状态机、崩溃恢复和引导控制 |
| [命令参考](./user-docs/commands.md) | 所有命令、键盘快捷键和 CLI 参数 |
| [远程提问](./user-docs/remote-questions.md) | 用于无头自动模式的 Discord、Slack 和 Telegram 集成 |
| [配置](./user-docs/configuration.md) | 偏好设置、模型选择、Git 设置和 Token 配置 |
| [提供商设置](./user-docs/providers.md) | OpenRouter、Ollama、LM Studio、vLLM 以及所有受支持提供商的分步配置 |
| [自定义模型](./user-docs/custom-models.md) | 高级模型配置，包括 `models.json` 结构、兼容标志和覆盖项 |
| [Token 优化](./user-docs/token-optimization.md) | Token 配置、上下文压缩、复杂度路由和自适应学习 |
| [动态模型路由](./user-docs/dynamic-model-routing.md) | 基于复杂度的模型选择、成本表、升级策略和预算压力 |
| [捕获与分流](./user-docs/captures-triage.md) | 自动模式中的随手记录，以及自动分流处理 |
| [工作流可视化器](./user-docs/visualizer.md) | 用于查看进度、依赖、指标和时间线的交互式 TUI 叠层 |
| [成本管理](./user-docs/cost-management.md) | 预算上限、成本跟踪、成本预测和执行策略 |
| [Git 策略](./user-docs/git-strategy.md) | 工作树隔离、分支模型和合并行为 |
| [并行编排](./user-docs/parallel-orchestration.md) | 通过隔离的工作线程和协调机制同时运行多个 milestones |
| [团队协作](./user-docs/working-in-teams.md) | 唯一 milestone ID、`.gitignore` 设置和共享规划产物 |
| [技能](./user-docs/skills.md) | 内置技能、技能发现和自定义技能编写 |
| [从 v1 迁移](./user-docs/migration.md) | 将 `.planning` 目录迁移到新的 `.gsd` 格式 |
| [故障排查](./user-docs/troubleshooting.md) | 常见问题、`/gsd doctor`、`/gsd forensics` 和恢复流程 |
| [Web 界面](./user-docs/web-interface.md) | 通过 `gsd --web` 使用基于浏览器的项目管理界面 |
| [VS Code 扩展](../../vscode-extension/README.md) | 聊天参与者、侧边栏仪表板以及 VS Code 的 RPC 集成 |
