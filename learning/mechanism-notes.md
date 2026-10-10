# 学习面板插件机制笔记（阶段 2.0 产出）

> 调研日期：2026-10-10 ｜ 基于仓库 `/Users/bytedance/codes/open-source/deepseek-harness` 当前 checkout
> 本笔记记录 `dsh-learning-hub` 插件依赖的全部 API 面，供预览版升级时对照排查。

## 1. 外部插件包结构（无需进 monorepo、无构建步骤）

模板来源：`packages/preset/agent-preset/skills/cordis-plugin-development/templates/decoration/`
指南：`.../references/ui-plugin.md`

```
my-plugin/
├── package.json      # dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml  # - insert: 一行，把自己挂进组合
├── index.js          # host 半：export function apply(ctx)
└── client.js         # 浏览器半：window.__ModuleLoader__.load({ id, factory(require){...} })
```

- `package.json` 关键字段：
  - `dsh.bundle.patch: "./cordis.patch.yml"` —— 安装时应用的组合补丁
  - `dsh.client: { platform: 'web', immediately: true, inject: [...] }` —— 声明浏览器 bundle 及其包级依赖（inject 包名列表保证 factory 到达顺序）
  - `exports`: `.` → host 入口，`./client` → 浏览器 bundle
- 浏览器半工厂返回 `{ inject: ['slots', ...], apply(ctx) }`；React 用 `require('react')` 从浏览器模块表取，**不要**自己打包 React
- 副作用（监听器/定时器/样式）放进 `ctx.effect` / `ctx.on` 并返回清理函数
- 安装：`dsh plugin --profile web add file:<插件目录>`（底层转发 pnpm）

## 2. 右侧栏 Tab 注册（两阶段，官方公开路径）

文档：`packages/client/ui-sidebar-right/README.zh.md`；活样例：`packages/client/ui-sidebar-files/src/client/index.ts`

1. **类型**：`ctx.sidebarRightTabs.register({ id, kind, priority, title, guide })` → disposer
   - `id` 全局唯一（用包名）；`kind` 是页类型名；`priority: 'extension' | 'builtin' | 'fallback'`
   - `guide: [{ id, order, title, description, icon? }]` 让类型出现在开始页入口
2. **正文**：`ctx.slots.register({ name: 'sidebar.right.pane.tab', key: <类型的 id> }, BodyComponent)`
   - 可选：`sidebar.right.pane.tab.title` 席位注册 chip 标题组件
   - 框架注入 `useTabInfo()`（本插件 v0.1 未用）
3. 打开方式：用户从开始页点入口，或代码里 `ctx.sidebarRight.openTab(kind)`

## 3. Host 侧 HTTP 端点（面板读写数据的通道）

文档：`packages/host/webserver/README.zh.md`

- `ctx.webServer.register({ kind: 'exact'|'prefix', path: '/__learning-hub', handler(req, res) })` → disposer
- 匹配顺序：exact → 最长 prefix → fallback；重复路径抛错
- handler 完全拥有响应生命周期
- ⚠️ 无服务器级认证：route owner 自己负责请求策略。本插件对策：仅接受 confine 在 `learning/` 根内的 JSON 读写，文档注明 loopback 部署前提
- 为什么不用 Typert Remote namespace：官方 Remote（如 `workspaceFiles`）需要生成的严格 codec（`packages/api/gateway`），外部纯 JS bundle 代价过高；v0.2 再评估

## 4. 替代读取通道（本插件暂不需要，记录在案）

- `ctx.remote.workspaceFiles.read/stat/readBytes/list/changes(sessionId, path, ...)`：只读、按行分页、带目录 watch 流（`packages/api/workspace-files`）。若 v0.2 要「agent 改 progress.json 后面板实时刷新」，用 `changes` 流订阅即可，无需自建轮询

## 5. 文案

官方包走 `ctx.locale.register(ns, { zh, en })` + `ctx.locale.bind(ns)`。外部插件同样可用（decoration 模板带 `locale/*.json`）。v0.1 内联 zh/en 字典。

## 6. Mermaid

无任何官方 client 包携带 mermaid → 浏览器模块表里没有。对策：把 `mermaid.min.js` 拷进插件 `vendor/`，经 host 半的 HTTP 前缀路由 `/__learning-hub/vendor/mermaid.min.js` 提供，client 动态插 `<script>` 加载后 `mermaid.render`。
