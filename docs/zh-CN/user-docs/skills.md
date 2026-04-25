# 技能

技能（Skills）是当当前 task 匹配时由 GSD 加载的专用指令集。它们为 LLM 提供领域化指导，例如编码模式、框架惯用法、测试策略和工具使用方式。

Skills 遵循开放的 [Agent Skills 标准](https://agentskills.io/)，并且**不是 GSD 专属格式**。它们同样适用于 Claude Code、OpenAI Codex、Cursor、GitHub Copilot、Windsurf 以及其他 40+ agent。

## 技能目录

GSD 会按优先级顺序从两个位置读取技能：

| 位置 | 范围 | 说明 |
|------|------|------|
| `~/.agents/skills/` | 全局 | 对所有项目和所有兼容 agent 共享 |
| `.agents/skills/`（项目根目录） | 项目级 | 项目专用技能，可提交到版本控制 |

如果出现同名技能，全局技能优先于项目技能。

> **从 `~/.gsd/agent/skills/` 迁移：** 升级后首次启动时，GSD 会自动把旧版 `~/.gsd/agent/skills/` 中的技能复制到 `~/.agents/skills/`。旧目录会保留，以兼容旧流程。

## 安装技能

技能通过 [skills.sh CLI](https://skills.sh) 安装：

```bash
# 交互式：选择要安装的技能以及目标 agent
npx skills add dpearson2699/swift-ios-skills

# 非交互方式安装指定技能
npx skills add dpearson2699/swift-ios-skills --skill swift-concurrency --skill swiftui-patterns -y

# 安装仓库中的全部技能
npx skills add dpearson2699/swift-ios-skills --all

# 检查更新
npx skills check

# 更新已安装技能
npx skills update
```

### 入门技能目录

在执行 `gsd init` 时，GSD 会检测项目技术栈并推荐合适的技能包。对于 brownfield 项目，检测是自动的；对于 greenfield 项目，则由用户选择技术栈。

这个精选目录维护在 `src/resources/extensions/gsd/skill-catalog.ts`。每一条目都会把一个技术栈映射到一个 skills.sh 仓库，以及其中的具体技能名称。

#### 可用技能包

**Swift（检测到任意 Swift 项目，例如 `Package.swift` 或 `.xcodeproj`）：**

- **SwiftUI**：布局、导航、动画、手势、Liquid Glass
- **Swift Core**：Swift 语言、并发、Codable、Charts、Testing、SwiftData

**iOS（仅当 `.xcodeproj` 目标通过 `SDKROOT` 指向 `iphoneos` 时）：**

- **iOS App Frameworks**：App Intents、Widgets、StoreKit、MapKit、Live Activities
- **iOS Data Frameworks**：CloudKit、HealthKit、MusicKit、WeatherKit、Contacts
- **iOS AI & ML**：Core ML、Vision、端侧 AI、语音识别
- **iOS Engineering**：网络、安全、可访问性、本地化、Instruments
- **iOS Hardware**：Bluetooth、CoreMotion、NFC、PencilKit、RealityKit
- **iOS Platform**：CallKit、EnergyKit、HomeKit、SharePlay、PermissionKit

**Web：**

- **React & Web Frontend**：React 最佳实践、Web 设计、组合模式
- **React Native**：跨平台移动开发模式
- **Frontend Design & UX**：前端设计与可访问性

**语言：**

- **Rust**：Rust 模式与最佳实践
- **Python**：Python 模式与最佳实践
- **Go**：Go 模式与最佳实践

**通用：**

- **Document Handling**：PDF、DOCX、XLSX、PPTX 的创建和处理

### 维护目录

技能目录定义位于 [`src/resources/extensions/gsd/skill-catalog.ts`](../../../src/resources/extensions/gsd/skill-catalog.ts)。新增或更新一个技能包时：

1. 在 `SKILL_CATALOG` 数组中新增一个 `SkillPack` 条目，包含 `repo`、`skills` 和匹配条件
2. 基于语言检测做匹配时，使用 `matchLanguages`（取值来自 `detection.ts` 中的 `LANGUAGE_MAP`）
3. 基于 Xcode 平台做匹配时，使用 `matchXcodePlatforms`（例如 `["iphoneos"]`，取自 `project.pbxproj` 中的 `SDKROOT`）
4. 基于文件存在与否做匹配时，使用 `matchFiles`（对照 `detection.ts` 中的 `PROJECT_FILES`）
5. 如果这个技能包需要在 greenfield 选项中出现，把它加入 `GREENFIELD_STACKS`
6. 如果多个技能包共享同一个 `repo`，它们会被合并为一次 `npx skills add` 调用

## 技能发现

`skill_discovery` 偏好控制 GSD 在自动模式中如何发现技能：

| 模式 | 行为 |
|------|------|
| `auto` | 自动查找并应用技能 |
| `suggest` | 识别技能，但需要确认（默认） |
| `off` | 关闭技能发现 |

## 技能偏好

你可以通过偏好设置控制使用哪些技能：

```yaml
---
version: 1
always_use_skills:
  - debug-like-expert
prefer_skills:
  - frontend-design
avoid_skills:
  - security-docker
skill_rules:
  - when: task involves Clerk authentication
    use: [clerk]
  - when: frontend styling work
    prefer: [frontend-design]
---
```

### 解析顺序

技能可以通过以下几种方式引用：

1. **裸名称**：例如 `frontend-design`，会扫描 `~/.agents/skills/` 和项目内的 `.agents/skills/`
2. **绝对路径**：例如 `/Users/you/.agents/skills/my-skill/SKILL.md`
3. **目录路径**：例如 `~/custom-skills/my-skill`，会在其中查找 `SKILL.md`

全局技能（`~/.agents/skills/`）优先于项目技能（`.agents/skills/`）。

## 自定义技能

你可以通过新增一个包含 `SKILL.md` 的目录来创建自己的技能：

```
~/.agents/skills/my-skill/
  SKILL.md           — 给 LLM 的指令
  references/        — 可选参考文件
```

`SKILL.md` 中写的是当技能启用时，LLM 应遵循的指令。参考文件可由技能按需加载。

### 项目本地技能

如果想为某个项目提供专用指导，可以把技能放在项目里：

```
.agents/skills/my-project-skill/
  SKILL.md
```

项目本地技能可以提交到版本控制中，让团队成员共享同一套技能。

## 技能生命周期管理

GSD 会跨自动模式会话跟踪技能表现，并提供健康度数据，帮助你持续维护技能质量。

### 技能遥测

每个自动模式工作单元都会记录哪些技能可用、哪些技能实际加载。这些数据和现有的 token / 成本数据一起存入 `metrics.json`。

### 技能健康度面板

通过 `/gsd skill-health` 查看技能表现：

```
/gsd skill-health              # 总览表：名称、使用次数、成功率、token、趋势、最近使用时间
/gsd skill-health rust-core    # 查看单个技能的详细信息
/gsd skill-health --stale 30   # 查看 30+ 天未使用的技能
/gsd skill-health --declining  # 查看成功率在下降的技能
```

该面板会标出可能需要关注的技能：

- **最近 10 次使用的成功率低于 70%**
- **Token 使用量比上一个窗口上升 20% 以上**
- **过期技能**：超过设定阈值未使用

### 过期检测

长时间未使用的技能会被标记为 stale，并可自动降低优先级：

```yaml
---
skill_staleness_days: 60   # 默认 60；设为 0 表示关闭
---
```

过期技能会被排除在自动匹配之外，但仍然可以通过 `read` 显式调用。

### Heal-Skill（单元后分析）

如果把它配置为 post-unit hook，GSD 可以分析 agent 在执行中是否偏离了某个技能的指令。如果检测到明显漂移（例如 API 模式过时、指导错误），它会把建议修复写到 `.gsd/skill-review-queue.md`，供人工审核。

一个关键设计原则是：技能**永远不会被自动修改**。研究表明，人工策展的技能明显优于自动生成技能，因此保留人工审核是必要的。
