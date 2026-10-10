# 第 5 章 · 模型适配与 Web 架构：Harness 的两个边界

> 预计用时：2.5 小时 ｜ 前置：第 2、3 章
> 框架：**Harness 向外有两个边界——模型边界（LLM 适配层）与用户边界（Web client）。本章一次讲透。**

## 🎯 学习目标

1. 说清 `LlmAdapter` / `LlmRuntime` 的职责划分与 provider 字符串路由。
2. 背出 `StreamChunk` 七型协议，理解 `BlockAssembler` 的容错设计。
3. 解释「文件和图片从不原生发给 provider」的路由投影。
4. 追踪浏览器打开 `http://127.0.0.1:3180` 到界面可交互的完整 boot 链。
5. 说清 Host/Client 边界：哪些跑在 Node、哪些跑在浏览器、怎么通信。

---

## 📖 5.1 模型边界：Adapter + Runtime

`LlmAdapter` 是抽象基类，子类必须实现 `stream()`（[llm/src/index.ts:208-290](</Users/bytedance/codes/open-source/deepseek-harness/packages/llm/llm/src/index.ts:208>)）。`LlmRuntime`（即 `ctx.llm`）持有 `Map<provider路由名, AdapterRegistration>`：

```ts
// index.ts:1143-1156 —— 所有流式调用经过 Cordis waterfall
stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
  return this.streamWithRegistration(options)
}
private streamWithRegistration(options, prepared?) {
  return this.ctx.waterfall(this, 'llm/stream', options,
    () => this.adapterStream(options, prepared))
}
```

三个要点：

1. **`llm/stream` waterfall**（第 1 章的语义在这里复用）：重试、replay、路由中间件都挂在这里，不用改适配器
2. **provider 是字符串路由名**，不是厂商枚举：未注册抛 `NO_ADAPTER`（index.ts:993-995）。`llm-pi-ai` 的 providers 字典**键就是路由名**——我们在 daimon-web 里配的 `kimi-coding` 就是这样一个路由
3. **prepareCall 防 TOCTOU**（index.ts:933-941）：把 model 解析与后续 dispatch 绑定到同一代适配器实例，避免解析后路由被替换

---

## 📖 5.2 消息模型与路由投影

两层模型：**持久化消息**（System/Developer/User/Assistant/ToolResult，带 id 与 source）与 **7 类内容块**（text/reasoning/image/file/tool-call/tool-addition/tool-removal）。`ContentBlockMap` 是空接口 + 声明合并扩展点——和第 3 章 `SessionEventMap` 同一个手法。

关键设计：**文件和图片从不原生发给 provider**——`adapterStream` 派发前做路由投影（index.ts:1076-1084）：

| 内容 | 投影 |
|---|---|
| 文件 | 一律投影成句柄文本（DeepSeek 侧另有 files-api beta 通道） |
| 纯文本模型的图片 | 占位文本 |
| 工具增删 | 按路由声明的 `toolUpdate` 模式投影为 developer 消息 |

这解释了第 3 章「模型可见即已记录」的实现方式：日志里存原始块，**请求时才投影**——同一条历史对不同能力的模型呈现不同形态。

---

## 📖 5.3 流式协议：StreamChunk 七型 + BlockAssembler

适配器只发 7 种 chunk（[types.ts:452-466](</Users/bytedance/codes/open-source/deepseek-harness/packages/llm/llm/src/types.ts:452>)）：

```ts
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: ToolCallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }   // 携带组装好的权威块
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason; replayState?: ReplayEnvelope }
```

`BlockAssembler` 是唯一的 chunk→消息组装器，三处容错设计值得学：

1. **容忍 delta-only 协议**：无 block-start/end 也能组装（`ensure`，assembler.ts:91-99）
2. **block-end 后迟到的 delta 被忽略**——防止坏适配器撑爆内存
3. **适配器抛异常被归一化成终态 `error`/`aborted` finish chunk**（index.ts:1160-1171）——消费者看到的永远是合法流；但中间件与下游消费者的异常仍抛出，这是刻意边界

token 计数：`token-meter` 用固定密度估价（`CHARS_PER_TOKEN = 4`），有 provider 精确 usage 后切换锚点；压力超限触发压缩（第 3 章）；路由可用 `IMAGE_OFFLOAD_REQUIRED` 失败码要求卸载老图片后重试。

---

## 📖 5.4 用户边界：webserver、鉴权与 __DSH_BOOT__

切到另一个边界。浏览器打开 `http://127.0.0.1:3180` 时：

**index.html 不是静态文件直出**：`renderIndex` 先 emit `webserver/index-inject` 事件让各插件 push 注入行（webserver/src/index.ts:539-553），其中两行最关键——`__ModuleLoader__` facade 脚本和 `__DSH_BOOT__` 入口图（client-modules 贡献）。

**鉴权是「一次性启动 token 换持久 cookie」**：

```text
dsh web 打印带 ?token= 的 URL → GET / 校验 token → 签发 HMAC 签名 cookie
→ 302 到干净地址 → 后续 /api 请求凭 cookie + Host/Origin 检查
```

token 只在 `GET /` 有效一次——这就是为什么你可以安全地刷新页面但不能把带 token 的 URL 分享给别人后用很久。

**Host/Client 分工**：

| Node（Host） | 浏览器（Client） |
|---|---|
| 业务 service、api/*-controller Host entry、webserver | controller/client model（Host 状态镜像）、client/ui-* 插件、React 渲染 |
| **权威状态、持久化、mutation 顺序** | 只读镜像 + 意图发送 |

**通信**：unary RPC 走 `/api` HTTP 前缀；stream 与事件转发走 `/api/remote.mux` WebSocket 复用。

**浏览器 boot 顺序**（client/web/src/boot.ts:47-99）：

1. 等 `__DSH_BOOT_READY__`（保证注入行全部生效）
2. 读 `window.__ModuleLoader__` 建模块系统（读 `__DSH_BOOT__`）
3. 预取 `immediately` 层 bundle
4. `bootClient`：浏览器里**再跑一个 Cordis Loader**（client 侧插件树！）
5. `mountClient`：uiRenderer 到位即 `createRoot` → 渲染 `ctx.slots.renderSlot('root', {})`

> 📌 注意第 4 步：**Cordis 在浏览器里又跑了一遍**。client 插件和 host 插件共享同一套插件模型——「一切皆插件」贯穿两端。全应用只有一次 ctx 级 `renderSlot('root')`（app.tsx:21），其余都是父注册内部的子 slot。

---

## 🔗 端到端调用链 A：一次 LLM 请求（9 跳）

1. agent loop `buildRequest` 从 surface 派生冻结的 GenerateOptions（agent.ts:442），`prepareCall` 绑定适配器代（:604）
2. `stream(request)`（agent.ts:453）
3. `LlmRuntime.stream` → `llm/stream` waterfall（index.ts:1152）
4. `adapterStream`：文件/图片/工具投影 → dispatch（index.ts:1076-1095）
5. DeepSeek 适配器：idle watchdog → serialize 组装 Messages 请求体（工具映射 input_schema）→ 合并插件扩展字段
6. `fetch(POST /messages, accept: text/event-stream)`（adapter.ts:124）
7. SSE 回流：`parseSse` 逐帧解码 → `translate` 译成 StreamChunk（message_start/content_block_*/message_delta/message_stop）
8. 回到 loop：`live.push(chunk)` → BlockAssembler 组装 → settle 成 `assistant/message`（第 2 章的三轨在这里交汇）
9. 失败路径：适配器抛错 → 归一化终态 finish chunk → `llm-retry` 监听 `agent/request-error` 按策略退避重试

## 🔗 端到端调用链 B：浏览器到可交互（7 跳）

1. Host 启动：Loader 拉起插件树；webserver 监听；connection 挂 `/api`；gateway 挂 `/api/remote.mux` upgrade
2. URL 发布：`authenticatedUrl` 加 `?token=` → 打印 `dsh web: http://...` → 打开浏览器
3. GET /：renderIndex 注入 `__ModuleLoader__` + `__DSH_BOOT__`；验 token 签 cookie 302
4. 页面执行：`new AppWebEntry(el).run()`
5. boot 内核：等 `__DSH_BOOT_READY__` → 建模块系统 → 预取 immediate bundle → client 侧 Cordis Loader 逐 entry 激活
6. 挂载 UI：uiRenderer → React root → `renderSlot('root')`
7. ui-layout/ui-sidebar 等 root 级注册者拼出外壳 → **你看到完整界面**

---

## ⚠️ 常见坑

1. **以为 provider 是厂商枚举**：它是注册表路由名；写配置时 providers 字典的键即路由名
2. **自己写适配器乱抛异常**：会被归一化成 finish chunk，排查时以为「没报错但流结束了」
3. **把带 `?token=` 的 URL 当持久凭证**：一次性，换 cookie 后即失效
4. **在 client 插件里直接改状态**：权威状态在 Host，client model 是镜像；mutation 要走 RPC
5. **以为 token 估价精确**：CHARS_PER_TOKEN=4 是启发式，精确值要等 provider usage

---

## ✋ 自检问题

1. `llm/stream` waterfall 上适合挂什么横切功能？（举两例）
2. 适配器抛异常后，agent loop 看到什么？为什么这样设计？
3. 日志里存的是 file block 原文，纯文本模型请求时看到什么？在哪投影？
4. 刷新 `http://127.0.0.1:3180`（无 token）为什么不需要重新登录？
5. client 侧为什么也要跑一个 Cordis Loader？

## 🛠 练习

- **练习 5.1（读，30 分钟）**：读 `packages/llm/llm-deepseek/src/adapter.ts` 的 `generate` 方法，对照调用链 A 的 5-7 跳。
- **练习 5.2（观察，15 分钟）**：浏览器开 DevTools → Network，刷新 dsh 页面：找到 302 跳转、cookie 设置、`/api/remote.mux` 的 WebSocket 升级请求，逐一对应调用链 B。
- **练习 5.3（改，20 分钟）**：在你的 daimon-web profile 里给 `llm-pi-ai` 的 providers 加一个新路由（指向任意 OpenAI 兼容端点），重启后在设置页看到它即成功。

## 📝 测验

右侧栏「学习测验」→ **第 5 章**（5 题）。

## 📚 延伸阅读

- [docs/subsystems/llm-streaming.zh.md](</Users/bytedance/codes/open-source/deepseek-harness/docs/subsystems/llm-streaming.zh.md>) — LLM 流式子系统
- [docs/subsystems/web-client.zh.md](</Users/bytedance/codes/open-source/deepseek-harness/docs/subsystems/web-client.zh.md>) — client 分层（权威）
- [docs/subsystems/slots.zh.md](</Users/bytedance/codes/open-source/deepseek-harness/docs/subsystems/slots.zh.md>) — slot 扩展点
- [docs/deepseek-llm-api-wire-extensions.zh.md](</Users/bytedance/codes/open-source/deepseek-harness/docs/deepseek-llm-api-wire-extensions.zh.md>) — wire 协议扩展

---

> ✅ 下一章：**第 7 章 · 综合练习：用 Harness 改自己**——毕业设计。
