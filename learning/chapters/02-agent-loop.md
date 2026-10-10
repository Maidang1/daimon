# 第 2 章 · 核心循环 agent loop

> 预计用时：1.5–2 小时 ｜ 前置：第 1 章

## 学习目标

1. 理解 turn / step 的边界，以及一个 turn 内事件如何流转
2. 说清楚工具调用发生在循环的哪一环
3. 理解 inbox（回合中插入新消息）的处理机制

## 大纲与源码锚点

### 2.1 生命周期全景
- 精读 `docs/agent-lifecycle.zh.md`：turn 如何拆成 step
- 图解：`learning/diagrams/ch02-agent-loop.mmd`

### 2.2 源码主线
- 按顺序读 `packages/core/agent-loop/src/`：`agent.ts → assistant-stream.ts → tool-calls.ts → inbox.ts`（每文件先看导出和顶层注释）

### 2.3 落盘对照
- 找一条自己会话的 jsonl（位置见 `docs/subsystems/persistence.zh.md`），认出 turn/step/tool_call 事件

## 自检问题

1. step 和 turn 的边界分别由什么决定？
2. 会话恢复（resume）时 jsonl 事件如何被「重放」成内存状态？（提示：`packages/session/session-projection`）

## 练习

- 练习 2.1（观察）：在一次对话中途再发一条消息，观察 inbox 行为，对照 `inbox.ts` 实现解释你看到的现象。
- 练习 2.2（画）：画出 turn 生命周期流程图，标注每个阶段对应的源码文件，存入 `learning/diagrams/` 并和导师的图对比。

## 测验

见 `learning/quizzes/ch02.json`（在右侧「学习测验」面板答题）。