# daimon

<p align="center">
  <img src="assets/icon.png" width="160" alt="daimon icon">
</p>

基于 DeepSeek Harness (dsh) 的**个人常驻 agent**——名字取自希腊语守护灵，也是 daemon 的双关。

它常驻一个持久的 Python REPL，围绕它构建了目标管理、周期心跳、子代理家族、continual harness 记忆与自精炼，是一个能长期自主运行的 agent，而不是一轮一问的聊天机器人。

---

## 它能做什么

### 持久 Python REPL

模型唯一的执行入口是 `python` 工具：代码在一个**会话级持久解释器**（CPython 子进程）里逐 cell 执行，命名空间跨轮、跨上下文压缩都保留。

REPL 启动时自动注入一套运行时（`py/rlm/`），模型零 import 即可用：

- `bash("cmd")` — 异步 shell，返回活句柄，自带后台作业表；后台命令完成会推通知到会话
- `mcp` — kernel 内置 MCP 客户端（见下文）
- `harness` — 直接读写 harness 记忆条目（见下文）
- `rlm.host_request()` — 通往宿主的万能桥，全部 28 条 host wire 的底层
- `rlm.emit()` — 发送富显示事件到 Web 界面

> `bash()` 由 Python 进程直接起子进程，不经过 dsh 的 sandbox 策略，权限等同宿主进程。

### 文件与任务工具

- `fs` / `fs-search` — 文件读写、搜索
- `todo` — 任务清单（允许并行 in-progress）
- `ask-user` — 向人提问
- `present` — 展示内容
- persona / agent-instructions — 人格与指令注入
- compaction — token 压力自动压缩 + `/compact` 手动压缩

### 子代理家族

模型可以随时派生子代理，并对整个家族保持观察和通信：

- `subagent` — spawn 一个 continuable 后台子代理，返回 id 与显示路径
- `send_message` — 向 parent / sibling / child 直发或广播
- `list_agents` — 查看直属子代理名册（状态、时长、进度备注）

配套 Python skill 提供更细粒度控制：

| skill | 能力 |
|---|---|
| `agent_observe` | 列核心家族（父/兄弟/子女，含非活跃）、按 id/名读单个会话摘要、读最近消息预览 |
| `agent_message` | 按角色定向发消息或向 `"all"` 广播，返回投递回执 |

宿主侧还提供了 `rlm.run` / `rlm.create_session` / `rlm.find_models` / `rlm.collect`（有界等待子代理结束，超时返回快照不报错）等底层 wire。

### 目标、心跳与自愈

“常驻”由三件套支撑：

- **goal**：会话级目标。`goal.create(objective, token_budget)` 立目标，`goal.get()` 看剩余预算，`goal.complete()` 标记达成；goal round-driver 持续驱动 agent 朝目标推进。
- **rlm_heartbeat**：周期自检心跳，持久化在 `<dshHome>/rlm/heartbeats.json`，重启后过期 beat 立即补发。投递分 `steer`（打断当前轮）和 `follow_up`（等轮结束）两种模式。调度由 rlm-bindings 自带，不依赖 dsh 的 schedule 插件。
- **compact**：`compact.status()` 看 token 压力，`compact.run()` 调度空闲时压缩，绝不在 cell 中途执行。

### 记忆与自精炼（Continual Harness）

每个会话（及机器全局）有一个类型化的 harness 状态，分四类条目：`prompt` 提示笔记、`memory` 记忆、`skill`、`subagent` 人格。

`refine.run()` 在回合边界排入一次精炼：agent 自己审视近期行为、更新 harness 条目并重建 system prompt——即**自己改写自己的长期记忆与人格**。全部变更以 proposal 形式原子应用或全不应用，历史可回放、可 rollback。

状态由 `rlm-harness-local` provider 持久化：JSON 落盘在 `<dshHome>/rlm/harness/`，跨进程文件锁 + 原子 rename 提交，损坏文件读作空状态。

### MCP 客户端

在 `dsh-home/mcp-servers.json` 声明服务器：

```json
{
  "名称": { "type": "http", "url": "..." },
  "另一个": { "type": "stdio", "command": "..." }
}
```

支持 env 引用、`enabledTools` / `disabledTools` 等字段（见 vendored `rlm-bindings` 的 README）。文件每次请求重读，改完即生效。

模型在 REPL 里直接使用：

```python
mcp.list_tools("名称")
mcp.call_tool("名称", "工具名", {...})
```

> 凭证刷新（`mcp.refresh`）与 OAuth 登录（`mcp.begin_login`）无后端，恒失败。当前仓库未预置任何 MCP 服务器。

---

## 快速开始

```sh
cd <本仓库>
pnpm install && pnpm build   # 首次：装依赖并从 src 构建 packages/*/lib
export DSH_HOME="$PWD/dsh-home"
npx -y @deepseek-ai/dsh@next --profile daimon-web
```

其中 `DSH_HOME` 指向的是仓库内自带的 `dsh-home` 目录（profile、会话、凭证等运行时数据都在里面）。

运行后输出一个带 token 的 URL，浏览器打开即可（监听 `127.0.0.1:3180`）。

首次使用在 Web 设置页填 DeepSeek API key，凭证由 `credentials` 插件托管。

`packages/*` 的 `lib/` 是构建产物、不进 git（`pnpm build` 经 turbo 用 tsdown 从 `src/` 单段构建 JS 与类型声明，测试为 `pnpm test`）；依赖方面，vendored 包之间的互相引用保留 `workspace:*`（由根 pnpm-workspace.yaml 解析为 link），对上游已发布包的依赖使用固定版本号。

---

## 项目结构

```
daimon/
├── package.json + pnpm-workspace.yaml   # 根 workspace，为 vendored 包安装已发布依赖
├── packages/                            # 全部 vendor 自 deepseek-harness（未发布 npm）
│   ├── rlm-kernel/              # RLM kernel 能力缝：ctx.rlmKernel 服务定义与线协议
│   ├── rlm-kernel-python/       # CPython provider + REPL 运行时 + py/skills（6 个）
│   ├── tool-python/             # 暴露给模型的 python 工具
│   ├── rlm-harness/             # continual harness 抽象 seam（条目 + 精炼事件）
│   ├── rlm-harness-local/       # harness 的 JSON 文件 provider（已接线）
│   └── rlm-bindings/            # 28 条 host_request 宿主绑定（已接线，自带 patch 自注入）
└── dsh-home/profiles/daimon-web/
    ├── package.json             # bundle 列表 + link:../../../packages/* 相对链接
    └── cordis.patch.yml         # 全部定制：功能裁剪 + preset 同步裁剪 + 端口覆盖
```

profile 的 bundle 为 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` + 4 个 link 进来的 vendored 包。

---

## 宿主绑定（28 条 host wire）

`rlm-bindings` 注册 `ctx.rlmKernel` 的 host request handlers，一次接入服务所有会话。按域分组：

| 域 | 绑定 | 说明 |
|---|---|---|
| 子代理 | `rlm.run` / `rlm.create_session` | spawn 子代理 |
| | `rlm.find_models` | 搜索模型目录 |
| | `rlm.list_subagents` / `rlm.delete_subagent` | 名册与清理 |
| | `rlm.collect` | 有界等待子代理结束 |
| | `rlm.progress.note` | 节流进度备注（10s） |
| | `bash.completed` / `bash.consumed` | 后台命令完成通知 |
| goal | `goal.get` / `goal.create` / `goal.complete` | 会话目标 |
| compact | `compact.run` / `compact.status` | 空闲时压缩 / token 压力 |
| 模型 | `model.info` | 调用方模型路由与输入模态 |
| MCP | `mcp.config` / `mcp.refresh` | 读服务器配置（refresh 恒失败） |
| 消息 | `agent_message.send` / `agent_message.list_agents` | 家族消息（list_agents 已迁移到 observe） |
| 观察 | `agent_observe.list` / `get` / `recent` | 家族名册、摘要、消息预览 |
| 心跳 | `rlm_heartbeat.create` / `update` / `list` / `delete` | 周期自检 |
| 精炼 | `refine.run` / `refine.status` | 回合边界 harness 精炼 |

模型侧不直接调 wire——6 个 Python skill（`goal` / `compact` / `refine` / `rlm_heartbeat` / `agent_message` / `agent_observe`）是它们的薄类型化封装，`import` 即用，零第三方依赖。

---

## 裁剪说明

官方 `web` 模板 182 行插件，patch 禁用 61 行 + 替换 2 个 preset config。

**保留**：Web 聊天、核心 agent（python/fs 工具、审批、设置/凭证、compaction、会话持久化）、delegation 三工具（preset 内 delegation 组）、goal 服务 + round driver（rlm-bindings 接线所需）。

**裁掉**：bash/pwsh 工具及 sandbox、子代理 fork 链路与 UI、计划模式、`/goal` 命令与 goal 工具、schedule（定时任务）、jobs（后台任务）、PTC/工作流、MCP 模型面工具、Web 搜索、技能系统、插件管理器、OTEL、HMR、Cordis 开发工具、pi-ai 适配器等。

> 注意 preset 是第二棵插件树：preset config 内嵌 Agent 作用域插件列表，顶层禁用够不到，必须整体替换 preset config 同步裁剪。以后裁工具要顶层和 preset 两层一起改；恢复某项删掉对应分组即可。分组注释见 `cordis.patch.yml`。

---

## 环境要求

- 宿主 `python3` 为 CPython 3.10+（加载时探测）
- `skill.py` 的 CLI helpers 需要 `tyro`（REPL 内 import skill 不需要）
- 模型 REPL 里用到的其他三方包需在宿主 Python 环境自行安装（如 `dill` 用于 namespace snapshot/restore），kernel 不自动装包

---

## 已知边界

- **验证裁剪要开新会话**：旧会话历史冻结了旧工具 schema。
- **typert 不能裁**：Web 的 workspace/session 控制器硬依赖。
- web 会话用 zstd 压缩，与不压缩的 profile 不能混读同一批会话目录。
- harness 与 prime-agent 的 snake_case 文件不互通，跨侧只走 host 接口。
- refine 请求仅存进程内存，重启即丢。
- 子进程不是安全边界，只约束资源形状。

---

## 验证

```sh
# 最终组合树
npx -y @deepseek-ai/dsh@next --profile daimon-web --dump-config

# 导入全部插件模块，diagnosis 应为空
npx -y @deepseek-ai/dsh@next --profile daimon-web --dump-config-schema
```

---

## 参考

- dsh 仓库 `docs/architecture.md`
- dsh 仓库 `docs/cookbook/extension-cookbook.md`

> API 为 pre-stable（0.1.x）。
