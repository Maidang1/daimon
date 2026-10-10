# 第 6 章 · 插件开发实战（元学习）

> 预计用时：2–3 小时 ｜ 前置：第 5 章

## 学习目标

1. 独立写出一个含 host + client 两半的完整插件
2. 理解本课程学习插件自身的每一行代码

## 大纲与源码锚点

### 6.1 元学习：读自己正在用的插件
- `learning/plugin/dsh-learning-hub/` 全部源码（约 400 行，就是最好的教材）
- 对照 `learning/mechanism-notes.md` 理解每个 API 选择的原因

### 6.2 官方教程
- `docs/cordis-tutorial/` 01–07 全篇
- Creator 模式的技能包：`packages/preset/agent-preset/skills/cordis-plugin-development/`

## 自检问题

1. client.js 里的 factory 为什么不能有副作用？
2. host 半的 HTTP 路由为什么要做路径 confinement？

## 练习

- 练习 6.1（实战）：给 dsh-learning-hub 加一个小功能（如错题重练按钮），全程自己写，导师只 review。

## 测验

见 `learning/quizzes/ch06.json`（在右侧「学习测验」面板答题）。