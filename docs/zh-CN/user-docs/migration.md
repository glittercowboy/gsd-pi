# 从 v1 迁移

如果你有仍在使用原始 Get Shit Done（v1）`.planning` 目录结构的项目，可以把它们迁移到 GSD-2 的 `.gsd` 格式。

## 运行迁移

```bash
# 在项目目录内执行
/gsd migrate

# 或者显式指定路径
/gsd migrate ~/projects/my-old-project
```

## 会迁移什么

迁移工具会：

- 解析旧版的 `PROJECT.md`、`ROADMAP.md`、`REQUIREMENTS.md`、phase 目录、计划、总结和研究文档
- 将 phases 映射为 slices、plans 映射为 tasks、milestones 映射为 milestones
- 保留完成状态（`[x]` 阶段保持已完成，原有 summary 会被带过来）
- 将研究文件整合进新的目录结构
- 在真正写入前先展示预览
- 可选运行一次由 agent 驱动的结果审查，以做质量保证

## 支持的格式

迁移器可处理多种 v1 文档变体：

- 按 milestone 分段、带 `<details>` 块的 roadmap
- 粗体 phase 条目
- 列表格式的 requirements
- 十进制 phase 编号
- 跨不同 milestones 重复的 phase 编号

## 前提条件

如果项目有 `ROADMAP.md` 来描述 milestone 结构，迁移效果最好。没有的话，系统会根据 `phases/` 目录推断 milestones。

## 迁移后

迁移完成后，用下面的命令检查输出结果：

```bash
/gsd doctor
```

它会检查 `.gsd/` 的完整性，并标出任何结构性问题。
