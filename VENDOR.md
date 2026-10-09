# Vendored packages

`packages/` 下的 6 个包 vendor 自上游开源仓库 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（MIT license）。

- 上游仓库：`git+https://github.com/deepseek-ai/deepseek-harness.git`
- 上游目录：`packages/rlm/*`（**上游 0.2.0 已删除该目录**，RLM 源码此后由本仓库自行维护）
- 上游版本：`0.1.7-rc.1`（git tag `dsh-v0.1.7-rc.1`，commit SHA `46a7f68b0922371ce7144b668b90e377d8e799f4`）
- dsh 运行时：`0.2.0-rc.2`（`client/runtime` 的 `@deepseek-ai/dsh` 与全部 `@deepseek-ai/dsh-*` 依赖）

> **源码与依赖的版本错位说明**：vendored 源码取自 rc.1 tag（上游最后一个含 RLM 的版本），但对上游 sibling 包的依赖（`@deepseek-ai/dsh-*`）钉在 `0.2.0-rc.2`。
> 即本仓库运行的是"rc.1 的 RLM 源码 + 0.2.0-rc.2 的 dsh 运行时"。
> 升级 0.2.0-rc.2 时对全部直接依赖做了 `.d.ts` 逐文件 diff：`dsh-agent` / `dsh-subagent` / `dsh-goal` / `dsh-compaction` / `dsh-tools` / `dsh-llm` /
> `dsh-token-meter` / `dsh-session-query` / `dsh-util-values` / `dsh-atomic-write` / `dsh-home-paths` / `dsh-brand` / `dsh-scope` / `dsh-timeout` /
> `dsh-agent-preset-registry` 与 0.1.7-rc.2 完全一致；`dsh-session` 仅新增导出 `ToolCallRecovery`（纯增量，无破坏）。
> 编译面兼容性由 `pnpm typecheck` 与 vitest spec 兜底（2026-10 升级时 9/9 任务全绿）。
>
> **0.2.0 运行时注意事项**：
> - 上游 web-app bundle 移除了 `schedule` / `ui-schedule` / `time-context` 行（schedule 能力移入 `dsh-experimental-schedule-bundle`，daimon 不挂载）；
>   新增 `desktop-product-telemetry` / `product-analytics`（仅 desktop profile 启用）与 `ui-settings-session-log`。
> - 上游 0.2.0 提供 `@deepseek-ai/dsh-experimental-ptc-runtime-python`（无状态 Python PTC 运行时），**不是**持久 REPL 的替代；
>   daimon 的持久 REPL 仍由本仓库 vendored 的 rlm-kernel-python 提供。

## 逐包清单

### `packages/rlm-bindings`（`@deepseek-ai/dsh-rlm-bindings`）

- vendor 自 `packages/rlm/rlm-bindings`，版本 0.1.7-rc.1
- 本地修改（见 `.changes/`）：
  - 新增 host 侧 bindings，应答 RLM runtime 的 subagent spawn、model search、roster、collect、progress-note、bash-notification 等 host request
  - `bash.completed` 绑定改为将完成通知投递进所属会话；`bash.consumed` 在通知仍 pending 时撤回
  - 新增 `mcpServersFile` 选项：kernel 从 JSON 文件读取声明的 MCP 服务器
  - 新增 goal / compact / model-info / MCP / agent-message / agent-observe / heartbeat / refine 等 host bindings，接线到 `agents`、`goals`、`compaction`、`tokenMeter` 服务

### `packages/rlm-harness`（`@deepseek-ai/dsh-rlm-harness`）

- vendor 自 `packages/rlm/rlm-harness`，版本 0.1.7-rc.1
- 本地修改（见 `.changes/`）：
  - 新增 `ctx.rlmHarness` 能力缝：harness 状态与精炼历史

### `packages/rlm-harness-local`（`@deepseek-ai/dsh-rlm-harness-local`）

- vendor 自 `packages/rlm/rlm-harness-local`，版本 0.1.7-rc.1
- 本地修改（见 `.changes/`）：
  - 新增 `ctx.rlmHarness` 的 JSON 文件 provider：DSH home 下一个全局 store + 每会话一个 store

### `packages/rlm-kernel`（`@deepseek-ai/dsh-rlm-kernel`）

- vendor 自 `packages/rlm/rlm-kernel`，版本 0.1.7-rc.1
- 本地修改（见 `.changes/`）：
  - 新增 `ctx.rlmKernel` 能力缝：每 agent 会话一个持久 Python REPL
  - 新增 `RlmKernel.registerHostRequestHandlers`：插件可为 composition 内所有 kernel 应答 runtime 的 `host_request` 类型

### `packages/rlm-kernel-python`（`@deepseek-ai/dsh-rlm-kernel-python`）

- vendor 自 `packages/rlm/rlm-kernel-python`，版本 0.1.7-rc.1
- 本地修改（见 `.changes/`）：
  - 新增 `persistent-kernel` 能力缝的 CPython provider：每 agent 会话一个解释器进程，运行时随包发布
  - 新增启动 bootstrap cell：将 `rlm`、`bash()`、`mcp` 绑定进 kernel 用户命名空间，模型代码无需显式 import
- 其他本地修改：
  - rlm-kernel-python: kernel 自动将 `py/skills` 注入 PYTHONPATH（替代原 profile 里的 pythonPath 绝对路径配置）
  - rlm-kernel-python: spawn 时导出 `RLM_HARNESS_STATE_DIR` / `RLM_GLOBAL_HARNESS_STATE_DIR`（复用 rlm-harness-local 的路径 helper），使 Python 运行时的 `rlm.harness` 与 host 侧 `ctx.rlmHarness` 共享同一份 JSON store
  - rlm-kernel-python: 修复 kernel bridge 并发与生命周期缺陷——acquire 等待 bootstrap 完成、输出事件按 cell id 归属、abort 监听随 cell settle 移除且 interrupt 携带目标 id、启动 stderr 诊断按上限累积、握手校验 `RLM_PROTOCOL_VERSION`、dispose 时 abort 在途 host 请求

### `packages/tool-python`（`@deepseek-ai/dsh-tool-python`）

- vendor 自 `packages/rlm/tool-python`，版本 0.1.7-rc.1
- 本地修改（见 `.changes/`）：
  - 新增 `python` 工具：每次调用在会话持久 Python 解释器里执行一个 code cell
