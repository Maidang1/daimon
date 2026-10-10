# 第 3 章 · 会话与记忆

> 预计用时：1.5–2 小时 ｜ 前置：第 2 章

## 学习目标

1. 理解会话的持久化格式与版本迁移链
2. 理解投影（projection）如何把事件流变成内存状态
3. 知道压缩（compaction）与上下文管理的触发点

## 大纲与源码锚点

### 3.1 会话格式
- 读 `docs/session-format-status.zh.md`：为什么有 v0→v4 五个版本
- 源码：`packages/session/session-format-*` 迁移链目录

### 3.2 持久化与投影
- `packages/session/session-persistence-jsonl`、`session-projection`、`session-projection-cache`
- 精读 `docs/subsystems/conversation.zh.md` 与 `docs/subsystems/session.zh.md`

### 3.3 压缩
- `packages/compaction/`：何时压缩、如何保留关键信息

## 自检问题

1. 为什么需要 session-format 版本迁移，而不是直接改格式？
2. projection cache 解决的是什么性能问题？

## 练习

- 练习 3.1（读）：打开一条自己会话的 jsonl，手工「重放」前 10 个事件，写出每步内存状态的变化。

## 测验

见 `learning/quizzes/ch03.json`（在右侧「学习测验」面板答题）。