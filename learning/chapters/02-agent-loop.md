# 第 2 章 · 核心循环 agent loop

> 预计用时：3 小时 ｜ 前置：第 0、1 章
> 源码主战场：`$REPO/packages/core/agent-loop/src/agent.ts`（ReactLoopAgent，705 行，全课程最值得精读的文件）

## 🎯 学习目标

1. 画出 turn / step 双层循环结构，说清两者边界由什么决定。
2. 追踪一个 chunk 从 SSE 到屏幕再到落盘的三轨旅程。
3. 解释 steer 与 cancel 的本质区别，及 inbox 双队列设计。
4. 说清工具调度的「执行乱序、提交保序」。
5. 理解「日志即事实源，内存只是投影」这条第一性原理。

---

## 💡 2.0 导入：你发消息的那 0.1 秒发生了什么

在 Web GUI 输入「总结一下 README.md」，回车。接下来一秒内：

- 你的消息变成一条**持久事件**落盘
- 一个「驱动器」从 idle 醒来，开 turn、开 step
- 系统提示词、工具定义、全部历史被**从日志现算**出来发给模型
- 模型流式吐出文字，UI 逐字渲染
- 模型说「我要调 read_file」→ 落盘 → 工具执行 → 结果落盘 → **再开一步**
- 模型说完总结，没有新工具 → turn 关闭，驱动器回 idle

这一秒的总导演就是本章主角 `ReactLoopAgent`。它不在任何「main 函数」里——如第 0 章所说，**agent loop 本身也是个插件**，靠 `ctx.agentLoop` 服务挂进系统。

---

## 📖 2.1 相位机与双层循环

Agent 没有显式状态机类，而是一个 `Phase` 可判别联合（[agent.ts:41-49](</Users/bytedance/codes/open-source/deepseek-harness/packages/core/agent-loop/src/agent.ts:41>)）：

```ts
type Phase =
  | { kind: 'idle'; lastTurn: number }
  | { kind: 'maintenance'; abort: AbortController; lastTurn: number; wakeRequested: boolean }
  | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }
```

对外只有 `idle | running` 两种 `agent/status`（maintenance 对外算 idle）。驱动器本体是 `kick()`（[agent.ts:254](</Users/bytedance/codes/open-source/deepseek-harness/packages/core/agent-loop/src/agent.ts:254>)）：

```ts
while (await this.turn()) {}   // turn() 返回 true = inbox 还有活，接着开下一 turn
```

双层结构：

```text
kick()
└─ while: turn()              ← turn = 唤醒到自然停止的完整活动
   └─ while: step()           ← step = 一次模型调用 + 它请求的全部工具
```

**turn 边界的决定因素**（集中在 [agent.ts:315-367](</Users/bytedance/codes/open-source/deepseek-harness/packages/core/agent-loop/src/agent.ts:315>)）：

```ts
const decision = await this.preStep(target, { turn, step })
if (decision.kind === 'reject') { turnEnds = { kind: 'blocked' }; return false }  // :319 pre-step 拒绝
if (turnEnds && decision.messages.length === 0) break     // :323 无新输入即停
...
if (turnEnds && this.inbox.nextStep.length === 0) break   // :365 自然停止
target = 'next-step'                                       // :366 后续 step 改认领 next-step
```

**step 的终态**决定 `turnEnds`：无 tool-call → `'completed'`；`max-tokens` → **粘性终态**（[agent.ts:343](</Users/bytedance/codes/open-source/deepseek-harness/packages/core/agent-loop/src/agent.ts:343>)：一旦触顶，后续正常 step 也不能降级）；有工具 → 执行后继续循环。

> 📌 第 0 章的定义现在落地了：**step = 一次模型请求 + 它调用的工具；turn = 零个或多个 step，不再欠工作时关闭。**

---

## 📖 2.2 流式响应的三轨处理

step 内 `for await (const chunk of stream)`，每个 chunk 进 `AssistantStreamAttempt.push()`（[assistant-stream.ts:60-69](</Users/bytedance/codes/open-source/deepseek-harness/packages/core/agent-loop/src/assistant-stream.ts:60>)）——**一份 chunk，三条轨道**：

```ts
push(chunk: StreamChunk): void {
  const timed = this.accumulator.push({ time: Date.now(), chunk })  // 轨道 1：持久 compact stream
  this.assembler.push(timed.chunk)                                    // 轨道 2：BlockAssembler 拼 block
  this.emit({ type: 'chunk', attemptId, index: this.index++, chunk }) // 轨道 3：UI 瞬态帧
}
```

- **轨道 3** 是你看到逐字打字的来源：`agent/assistant-stream` 瞬态帧，**不落盘**
- **轨道 1+2** 为持久化服务：流结束后**先落盘后通知**（[assistant-stream.ts:78-97](</Users/bytedance/codes/open-source/deepseek-harness/packages/core/agent-loop/src/assistant-stream.ts:78>)）——成功 → `assistant/message`（内嵌完整 compact stream）；失败/中止/重试 → `assistant/attempt`（只有 stream 没有消息）

> ⚠️ 为什么必须先落盘后通知？顺序反过来，UI 会显示一条**崩溃后无法回放**的消息——你看到了，但历史里没有。

词汇表（读代码前必先认识，`packages/llm/llm/src/types.ts`）：

| 词汇 | 定义 | 锚点 |
|---|---|---|
| `StreamChunk` | 7 种块级增量：block-start / text-delta / reasoning-delta / tool-call-delta / block-end / usage / finish | types.ts:452-462 |
| `ContentBlock` | 7 类内容块：text / reasoning / image / file / tool-call / tool-addition / tool-removal | types.ts:138-146 |
| `FinishReason` | 单次响应为何停：stop / tool-calls / max-tokens / aborted / error | types.ts:155-165 |
| `TurnEndReason` | 整个 turn 为何结束：completed / aborted / blocked / error / max-tokens（+interrupted/forked 补记用） | session/types.ts:201-228 |

注意 **FinishReason ≠ TurnEndReason**：前者是模型单次响应的，后者是整个 turn 的——别混淆。

---

## 📖 2.3 工具调用：执行乱序，提交保序

工具执行发生在 **step 内、`assistant/message` 落盘之后**（[agent.ts:549-554](</Users/bytedance/codes/open-source/deepseek-harness/packages/core/agent-loop/src/agent.ts:549>)）：

```ts
const toolCalls = message.content.filter(block => block.type === 'tool-call')
if (toolCalls.length === 0) return { kind: 'completed' }
const { concluded } = await executeToolCalls(this.loopCtx, turn, step, toolCalls, signal, ...)
return concluded ? { kind: 'completed' } : null   // null = 继续下一 step
```

`executeToolCalls`（[tool-calls.ts](</Users/bytedance/codes/open-source/deepseek-harness/packages/core/agent-loop/src/tool-calls.ts>)）的四个精巧点：

1. **屏障 + 有界并行池**：每次启动前重新查 `ctx.tools.executionMode()`——`exclusive` 构成独占屏障，`parallel` 进滚动池（默认上限 10）
2. **模型序提交**：`Promise.race` 并发收割，但 `commitReady()` 只按**连续模型序**提交结果（tool-calls.ts:147-161, 222）——**执行可乱序，结果落盘绝不乱序**，回放才有效
3. **回链**：启动时 `tool/call` 落盘，提交时 `tool/result` 带 `sourceEventSeqs: [callSeq]` 回链调用事件
4. **abort 兜底**：中止时未启动的调用补一条**合成错误结果**，保证回放时每个 tool-call 都有配对结果

---

## 📖 2.4 inbox 双队列：steer 与 cancel 的本质区别

inbox 是**持久化**双队列（每次变更都是 `agent/inbox/spliced` 日志事件，崩溃不丢）：

| 队列 | 认领时机 |
|---|---|
| `next-turn` | turn 首个 step 认领**一条** |
| `next-step` | 每个 step 边界认领**全部** |

四个入口是 `send()` 的预设别名（[agent.ts:154-181](</Users/bytedance/codes/open-source/deepseek-harness/packages/core/agent-loop/src/agent.ts:154>)）：

| 方法 | target | wakeup | 语义 |
|---|---|---|---|
| `followup` | next-turn | 是 | 排队下一轮（idle 时的正常发消息） |
| `steer` | next-step | 是 | turn 进行中注入，**下一 step 边界**生效，不打断当前流 |
| `inject` | next-step | **否** | 只排队不唤醒，等下一次边界顺带认领 |
| `cancel` | — | — | 清 inbox + abort AbortController |

> 📌 **steer vs cancel**：你在 agent 干活时发消息（steer），它**不会**打断当前模型流——消息排队，当前 step 结束后被认领，走同一个 `agent/pre-step` waterfall 进入下一步。你按停止按钮（cancel），才是直接 abort，循环内密布 `signal.throwIfAborted()` 检查点，被中断的流以 `interruptedBlocks()` 保留已交付文本落盘，turn 以 `aborted` 关闭。
>
> 隐蔽细节：abort 已生效时再来的消息被**重分类到 next-turn**（agent.ts:156-158），防止混入正在收尸的 turn。

---

## 📖 2.5 上下文组装：日志即事实源

每个 step 的请求由三段拼装，最关键的一条原则：

> **消息历史不从内存读**——`session.deriveMessages()` 从日志现算（[agent.ts:688](</Users/bytedance/codes/open-source/deepseek-harness/packages/core/agent-loop/src/agent.ts:688>)），深冻结后构造请求。

这就是为什么「每个模型请求都必须能从日志重建」（architecture.zh.md 的「模型可见即已记录」）。好处：崩溃恢复、fork、compaction 天然一致；代价：插件想注入内容**必须走正规渠道**（pre-step / 系统提示投影），不能偷偷改内存。

组装三段式：

1. **系统提示词**：`ctx.systemPrompt.assemble()` + 增量对账投影（变化才提交 `system/message`）
2. **运行时上下文**：投影成一条 `runtime-context` 来源的 UserMessage 注入
3. **请求配置**：`agent/request` waterfall 让插件改写 config → `llm.prepareCall()` 绑适配器；`request/header` 按 initial/resume/change/series 四种原因快照

错误处理路径：流中途失败 → 先落 `assistant/attempt` → `agent/request-error` waterfall **给插件一次重试机会**（重试不重复 pre-step 与用户消息准入）→ 不重试则抛 `LlmError` 上冒为 turn 级 error。

---

## 🔗 端到端调用链：从回车到第一个 token（12 跳）

1. 前端提交 → Session Controller 命令层组装 UserMessage（api/session-controller/src/commands.ts:340）
2. `agent.followup(message)`（commands.ts:364）
3. `send()` → `inbox.splice('next-turn')` 持久入队 + `wakeDriver()`（agent.ts:154-161, 214）
4. idle → running，发 `agent/status`，启动 `kick()`（agent.ts:233-241）
5. `turn()` 落 `turn/start`（agent.ts:307）
6. `preStep()`：inbox.claim 认领 → 组装系统提示 → `agent/pre-step` waterfall（agent.ts:271-284）
7. `step/start` 落盘（agent.ts:331）
8. `agent/request` waterfall 定 config → `prepareCall` → 系统提示/用户消息/request/header 依次落盘 → `deriveMessages()` 冻结请求（agent.ts:594-701）
9. `llm.stream(request)` 经 `llm/stream` waterfall 到适配器发 HTTP SSE（agent.ts:453）
10. start 帧 → 首个 `text-delta` chunk 到达 → `live.push(chunk)`（agent.ts:455-459）
11. `dispatch.emit('agent/assistant-stream', frame)`（assistant-stream.ts:60-69）
12. Client 侧转瞬态事件进 Conversation 装配层渲染 → **你看到第一个字**

---

## ⚠️ 常见坑

1. **手工构造 UserMessage 复用 id**：inbox fold 拒绝重复 id，直接炸投影（inbox.ts:44-51）
2. **在错误的地方 steer**：续跑唯一正规渠道是 `agent/turn-stopping` 监听器里 `agent.steer()`；别处时机可能错过认领批次
3. **以为 max-tokens 后 turn 还能 completed**：粘性规则，触顶即定终身
4. **独占工具和并行工具混排**：exclusive 构成隐式屏障，拖慢整池
5. **监听 `agent/assistant-stream` 做持久化**：那是瞬态帧，会丢！持久化要读 `assistant/message` 内嵌的 compact stream

---

## ✋ 自检问题

1. step 和 turn 的边界分别由什么决定？（用 agent.ts:319/323/365 三行回答）
2. steer 进行中断与 cancel 中断在落盘事件上有何不同？
3. 为什么「执行乱序、提交保序」对回放是必需的？
4. turn 第 2 步 max-tokens、第 3 步正常完成，turn/end 的 reason 是？
5. 崩溃恢复时，jsonl 里的事件如何「重放」成内存状态？（提示：projection，第 3 章展开）

## 🛠 练习

- **练习 2.1（读，45 分钟）**：按「llm/types.ts 词汇（63-165, 445-462 行）→ agent/src/runtime-types.ts 的 Agent 接口注释（注释即规格）→ agent.ts 的 Phase → wakeDriver/kick → turn() → step()」顺序精读。
- **练习 2.2（观察，15 分钟）**：在 dsh 会话中发一条消息，趁 agent 工作时再发一条（steer），然后按停止（cancel）；之后找到该会话的 jsonl（`~/.dsh` 或 dsh-home 下），用 `rg 'turn/end' session.v4.jsonl` 对比两次中断的事件差异。
- **练习 2.3（读测试，30 分钟）**：`packages/core/agent-loop/tests/` 的 loop.spec.ts、inbox.spec.ts、cancel.spec.ts——测试覆盖了本章全部机制，是最好的验收材料。

## 📝 测验

右侧栏「学习测验」→ **第 2 章**（5 题）。

## 📚 延伸阅读

- [docs/agent-lifecycle.zh.md](</Users/bytedance/codes/open-source/deepseek-harness/docs/agent-lifecycle.zh.md>) — 官方 Mermaid 时序图（权威）
- [docs/subsystems/core.zh.md](</Users/bytedance/codes/open-source/deepseek-harness/docs/subsystems/core.zh.md>) — 取消与错误恢复
- [packages/core/agent-loop/README.zh.md](</Users/bytedance/codes/open-source/deepseek-harness/packages/core/agent-loop/README.zh.md>) — 实现决策集

---

> ✅ 下一章：**第 3 章 · 会话与记忆**——这条 append-only 日志如何落盘、版本迁移、以及对话太长时如何压缩。
