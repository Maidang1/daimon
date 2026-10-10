# 第 3 章 · 会话与记忆

> 预计用时：2.5 小时 ｜ 前置：第 2 章
> 源码主战场：`$REPO/packages/core/session/src/`（types.ts 词汇表 + index.ts 的 Session 实现）

## 🎯 学习目标

1. 用一句话说清事件溯源：**git 之于源码 = Session 日志之于对话**。
2. 认识 jsonl 落盘格式（头行 + 一事件一行）与路径布局。
3. 描述 resume 的完整过程：撕裂尾修复 + interrupted 关闭事件 + seed 重放。
4. 解释为什么需要 v0→v4 迁移链，以及「历史文件逐字节不动」原则。
5. 说清压缩的本质：**对模型是替换，对存储是纯追加**。

---

## 💡 3.0 导入：kill -9 之后，你的会话还在

做个实验（本章练习会真的做）：和 agent 聊到一半，直接 `kill -9` 干掉 dsh 进程。重新启动——会话完好无损地回来了，甚至那个「被打断的回合」都被如实记录为 `interrupted`。

没有数据库，没有复杂的崩溃恢复协议。只有一条 **append-only 的事件日志**。本章回答：这条日志长什么样、写在哪、崩溃后怎么重放、格式升级怎么办、对话太长怎么压缩。

---

## 📖 3.1 事件模型：一份可声明合并的词汇表

`SessionEventMap`（[core/session/src/types.ts:281](</Users/bytedance/codes/open-source/deepseek-harness/packages/core/session/src/types.ts:281>)）是**故意留主干、靠各包声明合并扩展**的接口——core 定义边界与消息事件，compaction、title、goal 等子系统各自往里加键。主干词汇：

| 类别 | 事件 |
|---|---|
| 边界 | `turn/start`、`turn/end`、`step/start`、`step/end` |
| 消息 | `system/message`、`developer/message`、`user/message`、`assistant/message`（内嵌精确 stream）、`assistant/attempt`（失败尝试） |
| 工具 | `tool/call`（原始未解析参数串）、`tool/result` |
| 请求快照 | `request/header`、`request/context` |

事件信封（types.ts:493）的关键设计：

```ts
{ type: K, seq: SessionSeq, time: number, data: SessionEventMap[K], ignorable?: true }
// 只有五种"产消息"事件能携带 surfaceOp / sourceEventSeqs —— 编译期隔离
```

**日志永远 append-only，但模型可见的 surface 允许被替换**（`surfaceOp: {op:'replace', startSeq, endSeq}`）——这是压缩的地基，记住这句话。

`Session.append()`（[index.ts:798](</Users/bytedance/codes/open-source/deepseek-harness/packages/core/session/src/index.ts:798>)）是**纯同步、热路径零 I/O**：JSON 快照（拒绝 BigInt/Date/环）→ 深冻结 → 校验 → 入 log → 同步广播 `session/event`。

---

## 📖 3.2 jsonl 落盘：头行 + 一事件一行

**路径**（session-persistence-jsonl/src/format.ts）：

```text
~/.dsh/sessions/<projectKey>/<encodeSegment(sessionId)>/session.v4.jsonl.zstd
```

- `projectKey(cwd)`：项目路径折叠成 `--Users-bytedance-codes-open-source-daimon--` 这样的 slug（**有意有损**，别拿它反推 cwd）
- `encodeSegment(id)`：SessionId 是任意外部字符串，**单射转义防 `../` 目录穿越**——直接拼路径就是漏洞
- 文件名带代际：`session.v4.jsonl`，zstd 帧压缩；**已发布的代际文件绝不重命名、替换、删除**

**真实一行**（本机 `~/.dsh` 里一条 tool/result，已脱敏）：

```json
{"type":"tool/result","seq":21,"time":1791539945183,
 "data":{"turn":1,"step":1,"message":{"role":"tool","toolCallId":"call_00_xxx","content":[...],"isError":false}},
 "sourceEventSeqs":[20],"surfaceOp":"append"}
```

逐字段：`seq` = 日志序号（连续无洞）；`data.turn/step` = 归属坐标；`sourceEventSeqs:[20]` = 回链 seq 20 的 `tool/call`；`surfaceOp:"append"` = 追加进 surface 尾部。

**写入是异步的**：活跃事件进缓冲，**200ms 批窗口**到期后批量 `append + fsync`（storage.ts:36）。首写用 **link()+unlink() 而非 rename()** 发布——link 遇到已存在目标会失败，rename 会静默覆盖。

> 📌 **append 返回 ≠ 已持久化**。热路径不能阻塞模型流，所以 write-behind；但「模型请求前缀必须 durable，否则崩溃后日志会声称模型看到了它没见过的上下文」——于是 `session-checkpoint-policy` 在**每次模型请求前、工具派发前**强制 `flush()`。

---

## 📖 3.3 会话恢复：重放 = 把日志再 append 一遍

`AgentLoop.resumeWith`（[agent-loop/index.ts:853-915](</Users/bytedance/codes/open-source/deepseek-harness/packages/core/agent-loop/src/index.ts:853>)）：

```ts
handle = await persistence.open(id, 'write', ...)      // 先抢写租约（防双开）
const coldRead = await handle.read(0, undefined, ...)  // 全量读有效连续前缀
const closers = interruptedTurnClosers(persisted)      // 语义修复：合成缺失的关闭事件
if (closers.length > 0) await handle.append(closers)   // 补记落盘
preparation = SessionPreparation.create(this.ctx.sessions.prepare(id, {
  seed: [...persisted, ...closers],                    // 重放 = 整段日志当构造种子
}))
```

**崩溃恢复分两层**，别混淆：

| 层 | 问题 | 修复 |
|---|---|---|
| 物理层 | 最后一条 zstd 帧写了一半（**撕裂尾**） | 扫描器只解码完整记录，尾部碎片截断重写（storage.ts:319-329） |
| 语义层 | turn 开着没关（有 turn/start 无 turn/end） | `interruptedTurnClosers` 合成 `step/end` + `turn/end{kind:'interrupted'}`（repair.ts:209） |

注意：`interrupted` 是**唯一不由 loop 现场发出**的 TurnEndReason——持久化不截断被中断的轮次，因为长任务的一个轮次可能价值巨大。

---

## 📖 3.4 格式版本 v0→v4：不可变历史 + 相邻迁移链

为什么需要版本迁移？因为**已发布格式的用户数据不可丢弃**（官方原话：prerelease 标记不会让持久化用户数据成为可丢弃数据）。

| 迁移 | 干了什么 |
|---|---|
| v0→v1 | 近似恒等：物理布局不变，header 版本提升 + 键名审计 |
| v1→v2 | 消灭顶层 `assistant/chunk`：流式 chunk 折进 `assistant/message.data.stream`，新增 `assistant/attempt` |
| v2→v3 | 系统提示词提升为一等 `system/message` 事件 |
| v3→v4 | 工具结果角色、消息 source 重写，扩展事件收编进 `plugin:` 命名空间 |

设计要点：

- **只允许相邻迁移**（vN→vN+1）：每条边只需理解两版差异，O(n) 条边覆盖 O(n²) 组合；链编译器构造时校验「0 到当前版每个整数恰好一条边」（chain.ts:66-72）
- **历史文件逐字节不动**：只读 open 单遍解码+迁移后直接返回；写 open 把迁移结果发布为**新的当前代际文件**到同目录
- **拒绝更高版本在校验 header 之前**：「请升级 harness」绝不被报成「日志损坏」

---

## 📖 3.5 压缩：对模型是替换，对存储是纯追加

对话太长触发压缩（挂 `agent/pre-step` 按 token 压力触发，或 `agent/request-error` 上下文溢出时强制）。三个审计事件 + 一次 surface 替换：

```text
compaction/start（拿锁）→ 生成摘要 → compaction/summary（记录 shadowedSeqs/shadowedTokenCount/哪个模型生成的）
+ user/message 的 surfaceOp:replace（摘要节点替换被遮蔽区间）→ compaction/end（放锁）
```

关键：**被遮蔽的旧事件仍在日志里**（可审计、`shadowedSeqs` 可溯源），`deriveMessages()` 只是不读它们。事务中途崩溃留下的是「有 start 无 end 的悬空锁」——可检测，而不是一个谎称成功的 end。

**投影**是读侧的另一半：每个投影单元是 `init / apply / stateVersion` 三元组——`apply` 对不关心的事件**必须返回同一引用**（`Object.is` 相等即零下游开销）；携带状态的事件必须带**变更后的完整值**，不能是裸 delta（每次转移 O(1)）。标题、token 统计、turn 边界都是投影。

---

## 🔗 端到端调用链：一次工具结果的一生（10 跳）

1. **产生**：`appendToolResult` → `session.append('tool/result', ..., surfaceOp:'append', sourceEventSeqs:[callSeq])`（tool-calls.ts:282）
2. **校验+提交**：JSON 快照、深冻结、校验 → `commit()` 入 log（session/index.ts:798-897）
3. **广播**：同步发 `session/event`
4. **路由**：jsonl 后端 `enqueueLive` 克隆入缓冲，arm 200ms 定时器
5. **批量落盘**：窗口到期 → eventLine 编码 → zstd 帧 → `open('a')` 追加 + fsync
6. **语义检查点**：下次模型请求前，`session-checkpoint-policy` 拦截强制 flush——**模型看到的上下文必然已 durable**
7. **崩溃/退出**：`session/disposed` → 最终排空 + 释放写租约
8. **重启 resume**：open 抢租约 → 全量扫描（丢弃撕裂尾）→ 必要时跑迁移链 → `interruptedTurnClosers` 补关闭事件落盘
9. **重放成内存态**：整段事件作为 seed 进 `Session` 构造器 → surface 同步折叠 → 投影注册表 eager 追平
10. **派生历史**：下一步请求 `deriveMessages()` 从当前 surface（含压缩 replace 节点）投影出 `Message[]` → 模型看到压缩后的连续对话

---

## ⚠️ 常见坑

1. **以为压缩删了历史**：没删，deriveMessages 只是不读被遮蔽节点；审计随时可查
2. **以为 append 返回即落盘**：只有 `flush()` resolve 才承诺 crash-safe
3. **统计时把 `interrupted` 当 loop 正常关闭**：它是崩溃补记的，loop 从不现场发出
4. **拿 projectKey 反推 cwd**：它是有意有损的人类可导航命名
5. **未知事件默认拒绝恢复**：未识别的必需事件可能改变后续日志的解释——「过度拒绝是麻烦，静默恢复被掏空的会话是事故」；只有显式 `ignorable: true` 才可跳过

---

## ✋ 自检问题

1. `Session.append()` 返回时事件已持久化了吗？什么才承诺 crash-safe？
2. resume 时的两层修复分别修什么？
3. v1 会话在 v4 构建上写 open 会发生什么？源文件会变吗？
4. 为什么压缩事务崩溃留下「悬空 start」而不是假 end？
5. 「模型可见即已记录」和第 2 章的 `deriveMessages()` 是什么关系？

## 🛠 练习

- **练习 3.1（观察，20 分钟）**：找一个本会话的 `session.v4.jsonl.zstd`（`~/.dsh/sessions/` 下按项目 slug 找），用 `zstdcat ... | head -3` 看 header 行和事件行，对照 3.2 的字段表逐字段认出 type/seq/surfaceOp。
- **练习 3.2（实验，15 分钟）**：开一个测试会话聊到一半，`kill -9` 进程，重启恢复：观察撕裂尾修复与 `turn/end{kind:'interrupted'}` 的补写。
- **练习 3.3（写，30 分钟）**：写一个最小投影（统计 user 消息数），体会 init/apply/stateVersion 与「返回同一引用 = 无变化」的约定——这是理解整个读侧最快的方式。

## 📝 测验

右侧栏「学习测验」→ **第 3 章**（5 题）。

## 📚 延伸阅读

- [docs/subsystems/persistence.zh.md](</Users/bytedance/codes/open-source/deepseek-harness/docs/subsystems/persistence.zh.md>) — 最佳总览
- [docs/session-format-status.zh.md](</Users/bytedance/codes/open-source/deepseek-harness/docs/session-format-status.zh.md>) — 版本发布记录
- [docs/subsystems/compaction.zh.md](</Users/bytedance/codes/open-source/deepseek-harness/docs/subsystems/compaction.zh.md>) — 压缩子系统
- [docs/persistence-catalog.zh.md](</Users/bytedance/codes/open-source/deepseek-harness/docs/persistence-catalog.zh.md>) — 全部事件字段目录

---

> ✅ 下一章：**第 5 章 · 模型适配与 LLM 层**——适配器 seam、流式协议、多提供商路由。
