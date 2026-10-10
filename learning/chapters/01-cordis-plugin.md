# 第 1 章 · 一切皆插件 + Cordis 基础

> 预计用时：2–3 小时（本课程最难的一章之一）｜ 前置：第 0 章

## 学习目标

1. 理解 Cordis 的五个核心思想：服务（service）、注入（inject）、事件、生命周期、组合（composition）。
2. 能读懂一条插件声明行（id / name / config / disabled / group）。
3. 能写出一个最小 Cordis 插件并挂进组合。

## 大纲与源码锚点

### 1.1 Cordis 是什么
- 阅读：`docs/cordis-primer.zh.md` 全文（官方入门教材）
- 源码：`vendor/cordis`（内核）、`vendor/loader`（YAML 装配器）、`vendor/group`（分组隔离）

### 1.2 组合与补丁：插件如何被装配
- 阅读：`packages/bundle/web-app/cordis.patch.yml`（web bundle 补丁），对照 `packages/bundle/base`
- 关键概念：`- insert:` 插入行、按 id 覆盖、profile 补丁最后叠加
- 事件流：`docs/event-producer-consumer.zh.md`

### 1.3 服务与注入
- 在仓库里找真实例子：`rg "ctx.inject" packages/interaction -l | head -5`，挑一个读
- preset 内部的服务隔离：`packages/core/scope/README.zh.md`

### 1.4 实战预习：preset 也是插件组合
- 读 `learning/preset-learning.yaml`，指出 persona 行的作用（提示：`packages/preset/persona/README.zh.md`）
- 思考：为什么 persona 必须挂在 preset 内部，不能全局挂载？

## 自检问题

1. `ctx.inject('xxx')` 在依赖尚未就绪时会发生什么？
2. cordis.patch.yml 里的补丁行是按什么规则生效的（insert / 覆盖 / 顺序）？
3. `disabled: !!js process.platform === 'win32'` 这种写法的求值时机是什么时候？

## 练习

- 练习 1.1（动手）：照 `docs/cordis-tutorial/` 第一篇，写一个最小插件：定义一个 service、用 `ctx.inject` 依赖另一个 service、监听一个事件。
- 练习 1.2（改）：复制 `learning/preset-learning.yaml`，给导师 preset 增加一个你感兴趣的工具行，说明它会如何改变学习会话的能力。

## 测验

见 `learning/quizzes/ch01.json`。
