# 第 5 章 · 模型适配

> 预计用时：1.5 小时 ｜ 前置：第 4 章

## 学习目标

1. 理解 llm 抽象层如何把不同提供方统一成一套接口
2. 能自己接一个新的 OpenAI 兼容端点

## 大纲与源码锚点

### 5.1 适配层
- `packages/llm/llm`（抽象）、`llm-deepseek`、`llm-pi-ai`（多提供方）
- 文档：`docs/deepseek-llm-api-wire-extensions.zh.md`

### 5.2 重试与计量
- `llm-retry`、`token-meter`

### 5.3 配置
- Settings → Models 背后的包：`packages/client/ui-settings-models` + `packages/credentials`

## 自检问题

1. 新增一个模型提供方需要动哪几层？
2. token-meter 的数据对谁可见？

## 练习

- 练习 5.1（配）：在 Settings → Models 里添加一个本地 Ollama 端点（或其他兼容端点），切换模型完成一次对话。

## 测验

见 `learning/quizzes/ch05.json`（在右侧「学习测验」面板答题）。