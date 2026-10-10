# 第 4 章 · 工具系统

> 预计用时：2 小时 ｜ 前置：第 3 章

## 学习目标

1. 理解工具从声明到执行到渲染的完整管线
2. 理解 fs/shell 工具的沙箱与权限模型

## 大纲与源码锚点

### 4.1 工具管线
- 读 `docs/tool-execution-pipeline.zh.md`
- 源码：`packages/core/tools`

### 4.2 文件工具
- `packages/fs/tool-fs`、`tool-fs-search`、`tool-str-replace-editor`、`fs-sandbox`
- 文档：`docs/subsystems/filesystem.zh.md`

### 4.3 Shell 工具与审批
- `packages/shell/bash-local`、`bash-sandbox`
- 文档：`docs/subsystems/approval.zh.md`：审批策略如何拦截命令

## 自检问题

1. 工具的 description 为什么会影响模型行为？（提示：工具目录进系统提示词）
2. fs-sandbox 的读写权限策略分别在哪里生效？

## 练习

- 练习 4.1（动手）：写一个最小工具插件，注册一个 `echo` 工具并在会话里让 Agent 调用它。

## 测验

见 `learning/quizzes/ch04.json`（在右侧「学习测验」面板答题）。