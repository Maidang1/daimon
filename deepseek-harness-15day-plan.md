# DeepSeek Harness 15 天精通计划（精细版）
> 目标：15 天后能独立为 DSH 设计并实现跨层功能、提交规范 PR
> 仓库：`/Users/bytedance/codes/open-source/deepseek-harness`（下文简称 `$REPO`）
> 每日投入：约 3.5 小时 = 阅读 1.5h + 实操 1.5h + 笔记复盘 0.5h
> 每天结尾必做：写学习笔记（模板见文末），并回答当天「自检问题」——答不出就标记为明天第一件事

---

## 第 0 条军规：怎么读这个仓库（每天通用）

1. **文档先行**：`docs/*.zh.md` 和 `docs/subsystems/*.zh.md`（60+ 篇子系统文档）是官方教材。先读 zh 版提速，关键术语对照 en 版。
2. **读代码的顺序**：包的 `README.zh.md` → `package.json`（看 exports）→ `src/index.ts`（看导出面）→ 核心实现文件。**不要从第一行开始顺序读。**
3. **搜索三板斧**（在 `$REPO` 下）：
   - `rg "export (function|class|const) X"` 找定义
   - `rg -l "someService"` 找谁在用它
   - `rg --files packages/core | rg agent` 按文件名找
4. **卡住超 30 分钟** → 直接把问题抛给我（daimon），我常驻此仓库，可帮你定位代码、画调用链。
5. **所有命令都在 `$REPO` 根目录执行**，包管理用 pnpm（不要用 npm/yarn）。

---

# 阶段一：使用者视角（Day 1–3）——先会用，再会改

## Day 1｜全景认知 + 环境跑通

**上午·阅读（1.5h）**
- [ ] `$REPO/README.zh.md` 全文——回答：DSH 解决什么问题？和裸调 LLM API 的本质区别？
- [ ] `docs/architecture.zh.md` 精读，重点三节：`Cordis`、`Profiles and bundles`、`Core packages`
- [ ] 扫一眼 `docs/glossary.zh.md`，把不认识的术语标黄（今天不强求全懂）

**下午·实操（1.5h）**
- [ ] 按 `docs/development.zh.md` 搭环境：`pnpm install` → `pnpm build`
- [ ] 从源码跑 CLI：`pnpm dsh`（等价于 `node --import tsx/esm apps/cli/src/bin.ts`）
- [ ] 跑一次 Web 端：`pnpm start:web`，浏览器开终端里给的 URL
- [ ] 完成一个真实小任务：让 agent 读你电脑上某个文件并总结。观察 Web GUI 右栏、审批弹窗、工具渲染
- [ ] 看 `docs/cli-help.zh.md`，把 `dsh --help` 每个子命令试一遍（`web`、`--profile` 等）

**自检问题**（答不出=明天第一件事）
1. `apps/`、`packages/`、`python/` 三层分别是什么角色？
2. Cordis 在 DSH 里扮演什么角色？（一句话）
3. `pnpm dsh` 和 `pnpm start:web` 入口是同一个文件吗？（是，`apps/cli/src/bin.ts`——去验证）

**📦 交付**：环境可复现笔记（Node/pnpm 版本、build 耗时、踩过的坑）

---

## Day 2｜核心概念：Turn / Step / Session 持久化

**上午·阅读（1.5h）**
- [ ] 精读 `docs/agent-lifecycle.zh.md`：一个 turn 如何拆成 step，工具调用发生在哪一环，inbox/中断如何处理
- [ ] 精读 `docs/subsystems/conversation.zh.md` 和 `docs/subsystems/session.zh.md`
- [ ] 读 `docs/session-format-status.zh.md`：会话格式为什么有 v0→v4 五个版本

**下午·实操（1.5h）**
- [ ] 源码对照：打开 `packages/core/agent-loop/src/`，按 `agent.ts → assistant-stream.ts → tool-calls.ts → inbox.ts` 的顺序读，每个文件先只看导出和顶层注释
- [ ] 找一条昨天会话的落盘文件（session jsonl，位置见 `docs/subsystems/persistence.zh.md`），用 `head -5` 看事件结构，对照文档认出 turn/step/tool_call 记录
- [ ] 运行 `pnpm dsh` 时故意中途发一条新消息，观察 inbox 行为，对照 `inbox.ts` 的实现

**自检问题**
1. step 和 turn 的边界分别由什么决定？
2. 会话恢复（resume）时，jsonl 里的事件是如何被"重放"成内存状态的？（提示：`packages/session/session-projection`）
3. 为什么需要 session-format 版本迁移？（看 `packages/session/session-format-v3-to-v4` 的目录名猜）

**📦 交付**：手绘/文字版 turn 生命周期流程图，标注每个阶段对应的源码文件

---

## Day 3｜Cordis：DSH 的 DI/插件内核（本周最难的一天）

**上午·阅读（1.5h）**
- [ ] 精读 `docs/cordis-primer.zh.md` 全文：五个核心思想、dispatch 模式、waterfall 语义、loader 配置
- [ ] 读 `docs/event-producer-consumer.zh.md`：事件如何在包之间流动
- [ ] 浏览 `docs/cordis-api/` 目录结构，知道去哪查 API

**下午·实操（1.5h）**
- [ ] 跟 `docs/cordis-tutorial/` 第一篇动手敲一个最小插件：定义 service → `ctx.inject` 依赖 → 监听/触发事件
- [ ] 读 `apps/cli/src/plugin.ts` 和 `profile-boot.ts`：真实产品里插件是如何被装配的
- [ ] 在仓库里找一个真实例子：`rg "ctx.inject" packages/interaction --files-with-matches | head -5`，挑一个读

**自检问题**
1. `Context` / `Service` / `Plugin` 三者的关系？
2. waterfall 语义和普通事件 emit 的区别？为什么工具审批要用 waterfall？
3. 如果两个插件都提供同名 service，会发生什么？

**📦 交付**：可运行的最小 Cordis demo（哪怕 20 行）+ 一页" Cordis 五思想"笔记

---

# 阶段二：开发者视角（Day 4–8）——读懂主干 + 第一次动手

## Day 4｜包地图与启动链路

**上午·阅读（1.5h）**
- [ ] `packages/README.zh.md` + `docs/module-graph.zh.md`：建立分层心智模型。注意 `packages/` 下是**分组目录**（如 `packages/core/` 里有 `agent`、`agent-loop`、`tools` 等多个包），不是单个包
- [ ] 读 `docs/subsystems/boot.zh.md` 和 `docs/subsystems/core.zh.md`
- [ ] 了解配置体系：`docs/config-catalog.zh.md`（这是生成文档，源在 `scripts/gen-config-catalog.ts`）

**下午·实操（1.5h）——追一条完整调用链**
- [ ] 从 `apps/cli/src/bin.ts` 出发，用「跳转到定义」一路追到 agent 主循环：`bin.ts → args.ts → profile-boot.ts → ... → packages/core/agent/src/dispatch.ts → agent-loop/agent.ts`
- [ ] 每跳一层记一行笔记：`文件:行号 — 这一步做了什么`
- [ ] 用 `pnpm mock:llm` 起 mock LLM server，让 CLI 连 mock，这样你能随意构造模型响应来观察行为（后面几天都会用到这个技巧）

**自检问题**
1. profile 和 bundle 分别决定什么？
2. CLI 和 Web 共享到哪一层开始分叉？（提示：`packages/host/webserver` vs `apps/cli`）
3. `pnpm dsh`、`pnpm start:web`、`pnpm dev:web` 三个命令的差异？（`dev:web` 有 HMR，改 client 代码不用刷新）

**📦 交付**：一张调用链笔记（≥10 跳，每跳带文件路径）

---

## Day 5｜工具体系：agent 的手和脚

**上午·阅读（1.5h）**
- [ ] 精读 `docs/tool-catalog.zh.md`（生成文档，先扫结构）和 `docs/tool-execution-pipeline.zh.md`（精读全文）
- [ ] 精读 `docs/subsystems/approval.zh.md` + `SAFETY.zh.md` + `docs/defensive-patterns.zh.md`
- [ ] 读 `docs/subsystems/tools.zh.md`

**下午·实操（1.5h）**
- [ ] 读 `packages/core/tools/src/` 里 2 个内置工具的完整实现（挑一个简单的一个复杂的），重点看：JSON schema 定义、execute() 结构、审批声明
- [ ] 读 `packages/interaction/user-approval/` 和 `permission-presets/`：审批策略在哪判定
- [ ] 用 mock LLM 构造一次「危险命令」工具调用，观察审批弹窗的触发路径

**自检问题**
1. 一个工具调用从「模型输出 tool_call」到「结果回灌上下文」经过哪几环？画出管线
2. 文件沙箱策略（workspace-write / danger-full-access）在哪一层生效？
3. 为什么长任务工具要支持"后台句柄 + 通知"模式？（cookbook「长时间运行的工作」一节）

**📦 交付**：工具执行管线图 + 审批决策点标注

---

## Day 6｜动手①：新增一个自定义工具（第一个完整改动）

**全天以 `docs/cookbook/adding-a-tool.zh.md` 为圣经**，逐节对照实操：
- [ ] 「最小形态」：先写出能编译的最小工具（建议题目：`git-status`——返回当前仓库分支/改动数/最近 commit）
- [ ] 「execute() 约定的规则」：按规范处理错误返回、输出截断
- [ ] 「执行策略与观测」：加合适的执行策略声明
- [ ] 「工具在 UI 中的渲染方式」+「Web Client 展示」：让你的工具在 Web GUI 里渲染得不难看
- [ ] 「验证」：写单测。参考 `packages/core/tools/tests/` 现有测试写法
- [ ] 运行：`pnpm exec vitest run <你的测试文件>`，通过后跑 `pnpm lint` 确认无告警

**自检问题**
1. 工具的 schema 描述写得好坏，对模型调用准确率影响多大？（用 mock LLM 试一版烂描述对比）
2. 你的工具需要审批吗？为什么？

**📦 交付**：自定义工具 + 通过的测试 + 在 Web GUI 里真实跑通一次的截图/记录

---

## Day 7｜LLM 抽象层 + 上下文管理

**上午·阅读（1.5h）**
- [ ] `packages/llm/README.zh.md`，然后读 `packages/llm/llm/`（抽象层）与 `packages/llm/llm-deepseek/`（具体 adapter）的 src
- [ ] `docs/deepseek-llm-api-wire-extensions.zh.md`：DeepSeek 私有协议扩展
- [ ] `docs/subsystems/llm-streaming.zh.md` 和 `docs/subsystems/token-meter.zh.md`
- [ ] `docs/subsystems/compaction.zh.md` + `docs/subsystems/spill.zh.md`：上下文满了怎么办

**下午·实操（1.5h）**
- [ ] 读 `packages/compaction/` 下四个包的 README（`compaction-basic`、`compaction-image-offload`、`compaction-tool-result-pruner`、`command-compact`），理解四种策略分工
- [ ] 读 `packages/llm/llm-retry/`：重试/退避怎么做的
- [ ] 实操：开一个有 mock LLM 的会话，连续聊很多轮触发 compaction，观察 session jsonl 里压缩事件的形态

**自检问题**
1. adapter 模式屏蔽了哪些差异？（协议、鉴权、流式格式、计费…）
2. compaction 和 spill 的触发条件分别是什么？谁先做？
3. token 计量在哪一层做？为什么不能在 adapter 里做？

**📦 交付**：笔记「上下文从满到恢复的全过程」，含事件序列

---

## Day 8｜动手②：新增 LLM adapter 或新包（二选一）

**上午+下午（3h）**
- 选项 A（推荐，更能练核心）：按 `docs/cookbook/adding-an-llm-adapter.md` 接一个你常用的模型（OpenAI 兼容端点最容易）
- 选项 B：按 `docs/cookbook/adding-a-package.zh.md` 建一个新插件包，理解脚手架、cordis 声明、挂载点
- [ ] 动手前先读 `docs/capability-seams.zh.md`——这是回答「新行为该放哪」的决策框架，**专业与否的分水岭**
- [ ] 完成后：`pnpm typecheck` + `pnpm lint` + 相关测试全绿
- [ ] 注意仓库有严格约束脚本（`verify-package-dependencies`、`verify-cordis-config` 等），跑 `pnpm constraints` 自查

**自检问题**
1. 你的 adapter/包为什么不放在 packages/core 里？（用 capability-seams 的语言回答）
2. cordis patch yml（如 `apps/cli/src/sdk-source.cordis.patch.yml`）是干什么的？

**📦 交付**：编译通过、最小可用的 adapter/包 + 一段「我为什么这样放」的设计说明

---

# 阶段三：高级主题（Day 9–12）——能设计功能的人

## Day 9｜子代理 / RLM / 调度：agent 的分身术

**上午·阅读（1.5h）**
- [ ] `docs/subsystems/subagent.zh.md` + `docs/subsystems/agent-team.zh.md`
- [ ] `packages/subagent/README.zh.md`，扫一眼子目录：`subagent-acp`、`subagent-claude-code`、`subagent-codex`、`subagent-dsh-sdk`、`subagent-fork-in-process`——理解"DSH 能派生外部 CLI agent"这一点
- [ ] `docs/subsystems/schedule.zh.md` + `docs/subsystems/jobs.zh.md`

**下午·实操（1.5h）**
- [ ] 读 `packages/subagent/tool-subagent/` 和 `tool-subagent-control/` 的实现：spawn/collect/interrupt 三个原语
- [ ] 读 `packages/rlm/` 的 `rlm-kernel` 与 `rlm-kernel-python`：理解 RLM（递归语言模型）模式——**我（daimon）就跑在这个模式上**，可以现场问我体验细节
- [ ] 实操：在一次会话里 spawn 两个子代理并行做小任务，观察事件流和结果回收

**自检问题**
1. 子代理的上下文隔离边界在哪？fork vs fresh 的区别？
2. 什么时候该用子代理，什么时候该用后台 job？
3. schedule 的 cron 提醒和一次性延时提醒在实现上有什么不同？

**📦 交付**：「subagent 生命周期」笔记（spawn → 运行 → steer → collect）

---

## Day 10｜MCP / Skills / 扩展机制

**上午·阅读（1.5h）**
- [ ] `docs/subsystems/mcp.zh.md` + `packages/mcp/README.zh.md`（`mcp-client`、`mcp-resources`）
- [ ] `docs/subsystems/skills.zh.md` + `packages/skill/` 下各包 README（`skill-filesystem`、`skill-office`、`tool-skill`）
- [ ] `docs/subsystems/extensions.zh.md`、`docs/subsystems/commands.zh.md`、`docs/subsystems/hooks`（若无则在 `packages/hooks/`）

**下午·实操（1.5h）**
- [ ] 给你本地的 DSH 配一个真实 MCP server：编辑 `$DSH_HOME/mcp-servers.json`（该文件每次请求重读，改完即生效），接一个 filesystem 或 fetch 类 MCP server，让 agent 调用它的工具
- [ ] 写一个本地 skill（Markdown 说明书形式），让 agent 在匹配任务时加载它
- [ ] 对比思考：MCP 工具 vs 内置工具 vs skill，三者的能力边界和适用场景

**自检问题**
1. MCP 工具出现在模型的工具列表里时，和内置工具有何区别？（审批？渲染？）
2. skill 的「按需加载」省的是什么？（提示：context 预算）
3. hook 和 event listener 的区别？

**📦 交付**：一个接通的 MCP 集成 + 一个自制 skill + 三者对比表

---

## Day 11｜Web 端与交互层

**上午·阅读（1.5h）**
- [ ] `docs/subsystems/web-client.zh.md` + `docs/subsystems/web-server.zh.md` + `docs/api-gateway.zh.md`
- [ ] `packages/interaction/README.zh.md`：`commands`（斜杠命令）、`tool-ask-user`、`user-questions`
- [ ] `docs/subsystems/deliverables.zh.md`：present 机制怎么实现的
- [ ] `docs/web-styling.zh.md`（改 UI 前必读）

**下午·实操（1.5h）**
- [ ] 起 `pnpm dev:web`（HMR 模式），改一处 client 代码观察热更新；再对比 `pnpm start:web`（需 rebuild）
- [ ] 按 `docs/cookbook/adding-a-settings-card.zh.md` 加一个设置卡片，端到端走通「client 组件 → 状态 → 持久化」
- [ ] 读 `packages/web/web/` 的目录结构，找到会话列表、消息渲染两个核心组件

**自检问题**
1. Web GUI 和 CLI 共享哪些包？分叉在哪？（回想 Day 4）
2. `window.__DSH_BOOT__` 是谁注入的？为什么不能直接用 vite dev server 跑 apps/web？（`docs/subsystems/web-server.zh.md` 有答案）
3. 审批弹窗的前后端交互走的是哪条通道？

**📦 交付**：一个可见的 UI 改动（截图）+ HMR 工作流笔记

---

## Day 12｜持久化演进 + 可靠性工程（读"血泪史"的一天）

**上午·阅读（1.5h）**
- [ ] `docs/persistence-catalog.zh.md` + `docs/experimental-persistence-catalog.zh.md`
- [ ] `docs/persistence-changes/` 目录：schema 变更如何登记
- [ ] `docs/upgrade-guide/` 里最近两篇升级指南
- [ ] 看 `packages/session/session-format-v0-to-v1` … `v3-to-v4` 的目录结构：迁移代码长什么样

**下午·实操（1.5h）**
- [ ] 精读 `docs/postmortem/` 里 1–2 篇事故复盘（**全仓库含金量最高的设计教材**，读它等于白嫖别人的线上事故）
- [ ] 按 `docs/cookbook/adding-a-session-format-version.zh.md` 读懂「加一个新格式版本」的完整流程（不必真的做，读懂即可）
- [ ] 跑 `pnpm persistence-changes` 看当前工作区的持久化变更检测报告

**自检问题**
1. 为什么持久化格式变更需要专门登记和审查？（`verify-persistence-changes` 这道 CI 门在防什么）
2. 向后兼容的代价是什么？什么时候允许 break？
3. 从 postmortem 里学到的一条可迁移到你日常工作的教训？

**📦 交付**：笔记「DSH 的 schema 演进机制」+ postmortem 读后感

---

# 阶段四：实战与产出（Day 13–15）——用真实贡献证明自己

## Day 13｜测试体系与基准

**上午·阅读（1.5h）**
- [ ] 精读 `docs/testing.zh.md`：理解 vitest 多套 config 的分工——
  - `vitest.config.ts` 单元测试（`pnpm test`）
  - `vitest.e2e.config.ts` 端到端（`pnpm test:e2e`）
  - `vitest.snapshot.config.ts` 快照（`pnpm test:snapshot`，`DSH_SNAPSHOT=record/refresh` 两种模式）
  - `vitest.web*.config.ts` Web 端三套（快照/性能/压力）
  - `vitest.expected.config.ts` 期望行为测试
- [ ] 读 `packages/test-support/`：测试基建（含 `llm-mock-server`）
- [ ] 读 `BENCHMARK.md`

**下午·实操（1.5h）**
- [ ] 跑 `pnpm test`（先跑 `pnpm build:native-system`，test 脚本已含）；挑 2 个失败/跳过的测试读懂原因
- [ ] 跑一个 benchmark：`pnpm test:bench`，读懂 `benchmarks/session-open/session-open.bench.ts` 在度量什么
- [ ] 给 Day 6 的工具补一个边界 case 测试（空输出/超长输出/异常），体验 `pnpm test:expected`

**自检问题**
1. snapshot 测试的 record 和 refresh 模式区别？什么时候用哪个？
2. 为什么 benchmark 要先 `build:bench` 再跑 built 版本？
3. CI 的 `check:all`（`scripts/run-gates.ts`）包含哪些门？挑三个说作用

**📦 交付**：本地全绿测试记录 + benchmark 结果截图 + 新增测试 1 个

---

## Day 14｜迷你项目：端到端跨层功能（全天 4h）

**任选一题（推荐 A）：**
- **A. 给 CLI/Web 加一个新斜杠命令**（如 `/stats` 显示当前会话 token 用量）
  - 涉及：`packages/interaction/commands/`（命令注册）→ `packages/llm/token-meter/`（数据来源）→ Web 渲染 → 文档
- **B. 给 Web 会话列表加一个过滤维度**
  - 涉及：`packages/session/session-query/` → `apps/web` 或 `packages/web/web/` UI

**硬性要求（模拟真实 PR 标准）：**
- [ ] 代码 + 单测，且 `pnpm exec vitest run <相关范围>` 绿
- [ ] `pnpm lint` 无新增告警
- [ ] 更新文档：**中英双语同步**——改 `*.md` 必须同步对应 `*.i18n.yaml`/译文，否则 `verify-translation-pairing` 会挂
- [ ] 如果动了持久化格式 → 走 `docs/cookbook/adding-a-session-format-version.zh.md` 流程
- [ ] commit message 符合 `CONTRIBUTING.zh.md` 规范，lefthook 钩子全过
- [ ] 最后跑 `pnpm check:ci:static` 或相关的 verify 脚本自查

**📦 交付**：一个可以当面试作品讲的完整 commit（写一段 PR description）

---

## Day 15｜复盘 + 走向社区

**上午（2h）**
- [ ] 精读 `CONTRIBUTING.zh.md`：分支模型、lefthook、CI gates、review 所有权（`.github/review-ownership/`）
- [ ] 把 15 天笔记整理成一篇文章：《DSH 架构导览：从一次回车到一行代码》，要求含：分层图、turn 数据流、工具管线、你的实战案例
- [ ] 自查文末「15 天验收标准」逐条打勾，做不到的标红并写下补齐计划

**下午（1.5h）**
- [ ] 在仓库 GitHub issues 里挑一个 `good first issue` 认领；或把 Day 14 的功能打磨成 PR/PR 草稿
- [ ] 提 PR 前最后检查清单：`pnpm typecheck` ✓ `pnpm lint` ✓ 相关测试 ✓ 双语翻译 ✓ `verify-md-links`（若改了文档）✓

**📦 交付**：对外可分享的总结文章 + 一个 PR（或 PR 草稿）+ 个人后续 30 天深化计划

---

# 附录

## 每日笔记模板
```markdown
# Day N — <主题>
## 今天学了（3-5 条，含文件路径）
## 自检问题回答
## 没搞懂的（→ 明天第一件事 / 问 daimon）
## 明日第一件事
```

## 常用命令速查
| 目的 | 命令 |
|---|---|
| 源码跑 CLI | `pnpm dsh` |
| 跑 Web（构建产物） | `pnpm start:web` |
| Web 开发模式（HMR） | `pnpm dev:web` |
| mock LLM server | `pnpm mock:llm` |
| 完整构建 | `pnpm build` |
| 单元测试 | `pnpm test` |
| 指定测试 | `pnpm exec vitest run <path>` |
| e2e / 快照 | `pnpm test:e2e` / `pnpm test:snapshot` |
| 类型检查 | `pnpm typecheck` |
| lint | `pnpm lint` |
| benchmark | `pnpm test:bench` |
| CI 静态门 | `pnpm check:ci:static` |

## 15 天验收标准（Day 15 自测）
1. 不看文档画出：apps → packages → cordis 分层图 + 一次 turn 的完整数据流（含文件路径）
2. 独立完成 cookbook 四大操作：加工具 / 加 adapter / 加包 / 加设置卡片
3. 随手打开任意 `packages/*/*/src/index.ts`，能说清这个包为什么存在、和谁交互
4. 说清 session 格式 v0→v4 的演进逻辑和迁移机制
5. 提交一个符合仓库全部规范的 PR（lint/typecheck/测试/双语 i18n/verify 门全过）

## 卡壳时的求助顺序
1. `rg` 搜源码（30 分钟原则）
2. `docs/subsystems/` 找对应子系统文档
3. 问我（daimon）——我运行在这套体系上，subagent/RLM/python-skill/心跳/present 这些机制可以直接给你"活体演示"
