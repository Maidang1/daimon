# 第 4 章 · 工具系统与权限

> 预计用时：2.5 小时 ｜ 前置：第 1、2 章
> 源码主战场：`$REPO/packages/core/tools/src/index.ts`（ToolRuntime，1991 行管线核心）

## 🎯 学习目标

1. 解剖一个工具的完整定义：schema + 执行体 + 渲染器的三层结构。
2. 画出执行管线：pre-execute → 审批 → 守卫 → execute → post-execute。
3. 解释审批为什么必须用 waterfall，以及 fail-closed 的默认姿态。
4. 指出文件沙箱的强制点在哪（答案不在工具里）。
5. 说清工具结果的四层后处理（窗口化/spill/管线/剪枝）。

---

## 💡 4.0 导入：那个弹窗背后有一整条管线

你用 agent 时见过这个瞬间：它要执行 `rm -rf build/`，屏幕弹出一个审批框——「允许一次 / 拒绝」。你点了允许，命令才跑。

这个弹窗不是工具自己弹的，也不是模型弹的。从你点击到命令执行，中间穿过了一条**五段管线**，而工具本身对「权限」一无所知——它只负责干活。本章把这条管线拆开。

> 📌 **一句话定位**：工具系统是以 `ctx.tools` 注册表为中心、以三段 waterfall 为扩展点、以 **fail-closed**（失败即拒绝）为默认姿态的执行管线。工具 = schema + 纯执行体 + 纯渲染器；权限、审批、沙箱、截断全部是管线上可插拔的阶段，**不是工具的职责**。

---

## 📖 4.1 一个工具的完整解剖（以 `read` 为例）

[packages/fs/tool-fs/src/read.ts:77](</Users/bytedance/codes/open-source/deepseek-harness/packages/fs/tool-fs/src/read.ts:77>)：

```ts
ctx.tools.register(defineTool({
  name: 'read',
  description: 'Read a UTF-8 text file and return line-numbered content.',
  parameters: {
    file_path: { type: 'string', required: true, description: '...' },
    offset: { type: 'number', description: '1-based first line to return. Defaults to 1.' },
    limit: { type: 'number', description: 'Maximum number of lines to return.' },
  },
  // + output.schema（输出校验）+ render（纯函数投影）+ execute（执行体）
}))
```

`defineTool()`（[core/tools/src/schema.ts:554](</Users/bytedance/codes/open-source/deepseek-harness/packages/core/tools/src/schema.ts:554>)）收编全部要素。**三层校验递进**：

| 层 | 在哪 | 管什么 |
|---|---|---|
| ① schema 校验（声明式） | defineTool 包装的 execute 入口 | 缺 required 字段、类型错 → `ToolArgsError`（schema.ts:597-600） |
| ② 值约束（命令式） | 工具体内（如 read.ts:55-61） | schema 表达不了的：`limit ≤ 配置上限` |
| ③ 输出校验 | output.schema | 每个成功值符合声明；`render(args, value)` 纯函数投影成模型可读的 ContentBlock |

> ⚠️ **执行体必须返回可 JSON 化的规范值，不是文本**。文本化是 render 的事——这让 UI 呈现、历史剪枝、token 计价都能操作结构化数据而非字符串。

---

## 📖 4.2 注册与模型可见：白名单四字段

注册是一行 `ctx.tools.register(definition)`（[index.ts:1069](</Users/bytedance/codes/open-source/deepseek-harness/packages/core/tools/src/index.ts:1069>)，返回 disposer，重名即抛）。对模型可见的链路：

```ts
// index.ts:855 —— 构造时把 schema 提供器接进系统提示组装
ctx.systemPrompt.tools(context => this.wireSchemas(context.scope))
```

- `schemas(scope)` 投影出**白名单四字段** `{name, description, parameters, deferLoading}`（index.ts:1266-1300）——`timeoutMs`、执行体、UI 呈现器**永不进 LLM 请求**
- `ToolLayer.admits()` 按 agent 作用域折叠 allow/deny：子代理可以只看见工具子集
- agent loop 在 `agent.ts:272` 调 `assemble()`，把 `assembly.tools` 写进请求

这就是为什么第 2 章说「工具定义随系统提示组装」——现在你看到了接口的两端。

---

## 📖 4.3 执行管线五段

主干在 `prepareExecution`（[index.ts:1499](</Users/bytedance/codes/open-source/deepseek-harness/packages/core/tools/src/index.ts:1499>)）：

```ts
const gate = await this.ctx.waterfall(
  carrier, 'tools/pre-execute', exec,
  () => Promise.resolve<PreToolDecision>({ kind: 'allow' }),
)
const askResolution = gate.kind === 'ask' ? await this.serviceAsk(exec, gate) : ...
const denialReason = decision.kind === 'allow' ? this.guardReason(exec) : decision.reason
```

| 段 | 机制 | 关键设计 |
|---|---|---|
| ① `tools/pre-execute` waterfall | 产出 `allow / deny / cancel / ask` | **故意不支持改写参数**——"arguments are already logged and presented"（index.ts:605），防止日志与执行漂移 |
| ② 审批解析 | `ask` 才走，见 4.4 | |
| ③ 单调守卫 | `guardReason` 只能返回拒绝理由或弃权 | **没有 allow 返回值**："listener ordering cannot turn a denial back into permission"（index.ts:725-732）——顺序无关的否决层 |
| ④ `tools/execute` around-waterfall | 超时/重试/指标包装 | `:1587` 真正调 `tool.execute()` |
| ⑤ `projectContent` → `tools/post-execute` → 物化 | 策略可替换内容/附加反馈 | `notifyResult` 先 `Object.freeze(exec)` 再 emit `tools/result`——观察者只能看不能改 |

任何一环抛异常都被规范化为 `isError` 结果，**而不是炸掉 agent 循环**。

---

## 📖 4.4 审批：第一个负责的人拍板

**为什么必须 waterfall？** 回到第 1 章的 9 行实现：waterfall 是环绕中间件，监听器 `next()` 委托下游、不调则短路。审批的语义天然是「**第一个应答占据唯一的决策槽位，其余让路**」——emit/parallel 表达不了「链式委托 + 短路」。

**封闭四值 + fail-closed**：`ApprovalOutcome = allowed-once | rejected | cancelled | unavailable`（[user-approval/src/index.ts:55](</Users/bytedance/codes/open-source/deepseek-harness/packages/interaction/user-approval/src/index.ts:55>)），`serviceAsk` 里**只有 allowed-once 放行**（index.ts:1758-1773）——模型能区分「人说不」和「没有审批通道」。

**策略在分发前短路**（user-approval/src/index.ts:275）：

```ts
if (this.effectivePolicy(session) === 'never') return 'rejected'
```

`'never'` 在 waterfall 分发**之前**短路——即用 `prepend` 注册的应答者也无法绕过。这是刻意的：never 的确定性不依赖注册顺序。

**UI 如何介入**：Host 的 `approval/request` waterfall 被转发为远程事件 → 浏览器端 `ui-approval` 接听弹 `ApprovalPanel` → 用户点击 resolve waterfall；用户不点而选委托，则 `next()` 让给下一个应答者。ACP 自动化桥提供机器应答者。

**审计**：`approval/asked` + `approval/decided` 成对落盘，且**必须在打开的 turn 内**——turn 是日志的提交/重放边界。

---

## 📖 4.5 文件沙箱：强制点在 provider，不在工具

很多人以为「写文件被拦」是 write 工具里的 if——错。强制点在 provider 层 `SandboxedFileSystem.checkedTarget`（[fs-sandbox/src/index.ts:122-143](</Users/bytedance/codes/open-source/deepseek-harness/packages/fs/fs-sandbox/src/index.ts:122>)）：

```ts
if (mode === 'danger-full-access') return target
if (mode === 'read-only') throw new FsError('... denied under read-only mode', 'FS_SANDBOX_DENIED')
const fresh = await this.resolve(target.displayPath)   // 立刻重新规范化，防 TOCTOU
for (const root of writableRoots(policy)) { ... }
```

- 只覆盖 `writeText`/`editText` 两个变更操作，**读取永远放行**
- `workspace-write` 可写根 = 工作区根 + `/tmp` + 平台临时目录
- 检查用**重新规范化后的新鲜 target**——防 check-here-write-there 的 TOCTOU 竞态
- bash 侧是**内核级**隔离（`confine()`），fs 侧官方明说是 "containment, not a security boundary"
- 被拒不是死路：模型可带 `sandbox_permissions` + `justification` 重试一次，走人审提级通道

> 🔍 你现在这个会话的文件策略是 `danger-full-access`（见会话运行时上下文）——对照 4.5 的阶梯想想这意味着什么。

---

## 📖 4.6 结果后处理四层

| 层 | 例子 | 锚点 |
|---|---|---|
| ① 工具自身窗口化 | read 默认 2000 行 / 50KB，超长行打截断后缀 | read.ts:15, read-render.ts:69 |
| ② 执行器边界 | bash 输出保留尾部，溢写 spill 临时文件附路径 | bash-local/src/index.ts:38,48 |
| ③ 管线内容回调 | projectContent / post-execute 替换内容 | index.ts:1649-1655 |
| ④ 历史剪枝 | ToolResultPruner：超 8192 码点的旧结果做「头4096+标记+尾1024」中段剪枝 | compaction-tool-result-pruner/src/index.ts:136-182 |

剪枝以 surface `replace` 写回 + 前置 `compaction/prune` 影子计价事件——**重放安全，不需要模型参与**。这是「事件溯源」红利的又一个例子（第 3 章细讲）。

---

## 🔗 端到端调用链：tool_use 到结果回填（含审批分支）

1. 模型返回 tool-call block → `executeToolCalls()`（tool-calls.ts:60），先落 **`tool/call`** 事件再执行
2. 按 executionMode 分组：parallel 池 / exclusive 屏障
3. `tools/pre-execute` waterfall → deny 直接出拒绝结果；ask 进 4；allow 进 5
4. **审批分支**：`serviceAsk` → `approval.request()` → 落 `approval/asked` → 策略 never 直接 rejected / ask 走 waterfall → UI 或 ACP 应答 → 落 `approval/decided` → 仅 allowed-once 放行
5. 单调守卫 `guardReason`：任一守卫给理由即拒绝
6. `tools/execute` around → `tool.execute()` → fs 过 checkedTarget 围栏 / bash 过内核沙箱
7. `projectContent` → `tools/post-execute` → 物化冻结 → emit `tools/result`
8. 循环侧落 **`tool/result`** 事件（回链 call 的 seq）
9. 下一步 `deriveMessages()` 把结果折回 transcript → 再次请求模型，闭环

---

## ⚠️ 常见坑

1. **缺插件 = 功能退化而非报错**：没挂 ApprovalService 时 ask 退化为拒绝；没有 UI 应答者得到 unavailable 也是拒绝——组合部署时每个可选 seam 的缺省姿态都要想清楚
2. **策略放错层**：需要交互的放 pre-execute 监听器，需要顺序无关安全性的放守卫——放反了会造成「后面的监听器把 deny 改回 allow」的语义事故（守卫无 allow 返回值正是为了杜绝它）
3. **想在 pre-execute 消毒参数**：不行，参数已先于执行落盘——消毒只能在执行体内做
4. **自己写工具让 presenter 抛异常**：presentCall/presentResult 会在旧日志重放上跑，必须永远不抛
5. **在 turn 外调 approval.request()**：直接抛——后台代码做权限检查会踩到

---

## ✋ 自检问题

1. 模型调工具缺 required 参数，错误在哪一层抛出？和工具体内的 parse 分工是什么？
2. `ToolGuard` 为什么没有 allow 返回值？这解决了什么事故？
3. 会话策略 `'never'` 时，prepend 注册的应答者能接到审批请求吗？为什么？
4. `workspace-write` 的写盘围栏在哪执行？为什么检查时要重新规范化路径？
5. toolResultPruner 剪枝如何保证重放安全？

## 🛠 练习

- **练习 4.1（读，30 分钟）**：对照 [docs/tool-execution-pipeline.zh.md](</Users/bytedance/codes/open-source/deepseek-harness/docs/tool-execution-pipeline.zh.md>) 官方 Mermaid 图，读 `core/tools/src/index.ts` 的 prepare → dispatch → finalize → finish 四个私有方法，一一对应。
- **练习 4.2（写，45 分钟）**：仿照 read.ts 写一个最小只读工具（比如 `count_lines`：数文件行数），体验 defineTool 三层校验与 render 纯投影约束。可挂在你的 daimon-web profile 里验证。
- **练习 4.3（观察，20 分钟）**：在 `workspace-write` 和 `danger-full-access` 两种预设下各让 agent 写一次工作区外的文件，观察 `[sandbox: ...]` 标记与提级提示的差异。

## 📝 测验

右侧栏「学习测验」→ **第 4 章**（5 题）。

## 📚 延伸阅读

- [docs/tool-execution-pipeline.zh.md](</Users/bytedance/codes/open-source/deepseek-harness/docs/tool-execution-pipeline.zh.md>) — 官方管线图（权威对照）
- [docs/tool-catalog.zh.md](</Users/bytedance/codes/open-source/deepseek-harness/docs/tool-catalog.zh.md>) — 生成式工具总目录
- [docs/subsystems/approval.zh.md](</Users/bytedance/codes/open-source/deepseek-harness/docs/subsystems/approval.zh.md>) — 审批子系统
- [docs/subsystems/permission-presets.zh.md](</Users/bytedance/codes/open-source/deepseek-harness/docs/subsystems/permission-presets.zh.md>) — 权限预设

---

> ✅ 下一章预告：第 3 章（会话与记忆）与第 5 章（模型适配）的研究笔记还在路上，来了就写。
