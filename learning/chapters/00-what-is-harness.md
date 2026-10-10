# 第 0 章 · 什么是 Agent Harness

> 预计用时：1–1.5 小时 ｜ 前置：无

## 学习目标

1. 说清楚 Agent Harness 解决什么问题，和「裸调 LLM API」的本质区别。
2. 说出 DSH 的三层结构（apps / packages / vendor）各自的角色。
3. 初步理解「一切皆插件」这句话的字面含义（第 1 章深入）。

## 大纲与源码锚点

### 0.1 一个问题：为什么需要 Harness
- 裸调 Messages API 只能得到「一轮文本」；真实 Agent 需要：工具调用循环、会话持久化、权限审批、上下文压缩、插件装配……
- 阅读：`README.zh.md`（根目录）——回答：DSH 把自己定位成什么？

### 0.2 全景架构
- 阅读：`docs/architecture.zh.md`，重点三节：Cordis、Profiles and bundles、Core packages
- 图解：`learning/diagrams/ch00-architecture.mmd`
- 三层结构速览：
  - `apps/`：表层（cli / web / desktop），入口 `apps/cli/src/bin.ts`
  - `packages/`：按域分组的能力包（core / session / llm / fs / shell / client …）
  - `vendor/`：内化的基础设施（cordis、cosmokit、schemastery…）

### 0.3 「一切皆插件」初印象
- 整颗心脏（agent loop、工具、甚至系统提示词）都是 Cordis 插件，靠 YAML 组合装配
- 证据：`packages/bundle/web-app/presets/standard.patch.yml` —— 一个 standard preset 就是一张插件清单
- 本课程自己的教学预设也是同样机制：`learning/preset-learning.yaml`

## 自检问题

1. `apps/`、`packages/`、`vendor/` 三层分别是什么角色？
2. 会话历史落盘在哪里、是什么格式？（提示：找 `packages/session/session-persistence-jsonl`）
3. 为什么说「换 UI 不换大脑」在 DSH 里是成立的？

## 练习

- 练习 0.1（读）：在 `packages/bundle/web-app/presets/standard.patch.yml` 里数出 standard preset 挂载了多少个 `tool-*` 插件，说出其中任意 3 个的用途。
- 练习 0.2（跑）：启动 web 端，完成一次真实对话，观察右侧栏与审批弹窗，记录你看到的三个 UI 区域分别对应哪些 `packages/client/ui-*` 包。

## 测验

见 `learning/quizzes/ch00.json`（在右侧「测验」面板答题）。
