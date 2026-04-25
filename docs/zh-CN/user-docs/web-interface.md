# Web 界面

> 新增于 v2.41.0

GSD 提供了基于浏览器的 Web 界面，用于项目管理、实时进度监控以及多项目支持。

## 快速开始

```bash
gsd --web
```

这会启动一个本地 Web 服务器，并在默认浏览器中打开 GSD 仪表板。

### CLI 参数（v2.42.0）

```bash
gsd --web --host 0.0.0.0 --port 8080 --allowed-origins "https://example.com"
```

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--host` | `localhost` | Web 服务器监听地址 |
| `--port` | `3000` | Web 服务器端口 |
| `--allowed-origins` | （无） | 允许的 CORS 来源列表，逗号分隔 |

## 功能

- **项目管理**：在可视化仪表板中查看 milestones、slices 和 tasks
- **实时进度**：通过 server-sent events 在自动模式执行期间推送状态更新
- **多项目支持**：通过 `?project=` URL 参数，在单个浏览器标签页中管理多个项目
- **切换项目根目录**：无需重启服务器即可在 Web UI 中切换项目目录（v2.44）
- **首次引导流程**：可在浏览器中完成 API key 设置和 provider 配置
- **模型选择**：直接从 Web UI 切换模型和 provider

## 架构

Web 界面基于 Next.js 构建，并通过桥接服务与 GSD 后端通信。每个项目都会拥有自己的 bridge 实例，以便在并发会话中保持隔离。

关键组件：

- `ProjectBridgeService`：按项目分配的命令路由和 SSE 订阅服务
- `getProjectBridgeServiceForCwd()`：根据项目路径返回独立实例的注册表
- `resolveProjectCwd()`：从请求 URL 中读取 `?project=`，若不存在则回退到 `GSD_WEB_PROJECT_CWD`

## 配置

默认情况下，Web 服务器监听在 `localhost:3000`。如需覆盖，可使用 `--host`、`--port` 和 `--allowed-origins`（见上面的 CLI 参数）。

### 环境变量

| 变量 | 说明 |
|------|------|
| `GSD_WEB_PROJECT_CWD` | 当未指定 `?project=` 时使用的默认项目路径 |

## Node v24 兼容性

Node v24 对类型剥离（type stripping）做了破坏性改动，曾导致 Web 启动时报 `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`。该问题已在 v2.42.0+ 中修复（#1864）。如果你仍然遇到这个错误，请升级 GSD。

## 认证令牌持久化

从 v2.42.0 起，Web UI 会把认证令牌持久化到 `sessionStorage`，因此页面刷新后不会丢失登录态（#1877）。在此之前，每次刷新都需要重新认证。

## 平台说明

- **Windows**：由于 Next.js webpack 在系统目录上会触发 EPERM 问题，Windows 下会跳过 Web 构建。CLI 仍然可完整使用。
- **macOS / Linux**：完整支持。
