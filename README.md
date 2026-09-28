# daimon

基于 DeepSeek Harness (dsh) 的个人常驻 agent（名字取自希腊语守护灵，双关 daemon）。组合方式：官方 `web` 模板裁剪 + 完整 RLM 栈——持久 Python REPL、子代理委托（spawn/collect）、目标管理、上下文压缩、定时心跳、家族消息与观察、continual harness 持久化、MCP 客户端。全部定制都在 profile 的 `cordis.patch.yml` 里；未发布 npm 的 RLM 包（`rlm-kernel`、`rlm-kernel-python`、`tool-python`、`rlm-harness`、`rlm-harness-local`、`rlm-bindings`）vendor 在 `packages/` 下，不依赖外部源码目录。

## 运行

```sh
export DSH_HOME=/Users/bytedance/codes/open-source/daimon/dsh-home
npx -y @deepseek-ai/dsh@next --profile daimon-web        # 输出带 token 的 URL，浏览器打开
```

首次使用在 Web 设置页填 DeepSeek API key（凭证由 credentials 插件托管）。端口 3180（patch 里 `webserver` 行可改；本机 3080 常被其他 dsh 实例占用）。

## 结构

```
daimon/
  package.json + pnpm-workspace.yaml   # 根 workspace：为 vendored 包安装已发布的运行时依赖
  packages/
    rlm-kernel/              # vendor 自 deepseek-harness: RLM kernel 能力缝（未发布 npm）
    rlm-kernel-python/       # vendor 自 deepseek-harness: RLM Python REPL kernel（含 lib 构建产物 + py 运行时）
    tool-python/             # vendor 自 deepseek-harness: 暴露给模型的 python 工具（未发布 npm）
    rlm-harness/             # vendor 自 deepseek-harness: continual harness 状态缝（未发布 npm，抽象 seam）
    rlm-harness-local/       # vendor 自 deepseek-harness: harness seam 的具体 provider（JSON 原子写，已接线）
    rlm-bindings/            # vendor 自 deepseek-harness: 28 条 host_request 宿主绑定（未发布 npm，已接线，见下）
  dsh-home/profiles/daimon-web/
    package.json             # bundle 列表 + link:../../../packages/* 相对链接
    cordis.patch.yml         # 全部定制：功能裁剪 + preset 同步裁剪 + 端口覆盖
```

克隆后在仓库根跑一次 `pnpm install`（为 `packages/*` 安装 schemastery / cordis / dsh-tools 等已发布依赖；三个 vendored 包的 `package.json` 已把 monorepo 的 `workspace:` 协议改成发布版本号）。

## 裁剪了什么

官方 web 模板 182 行插件，patch 禁用 61 行 + 替换 2 个 preset config。保留：Web 聊天、核心 agent（`python` 工具、fs 工具、审批、设置/凭证、compaction、会话持久化）、子代理 spawn 链路（核心服务 + spawn provider + `subagent`/`send_message`/`list_agents` 三个模型面工具，preset 内 delegation 组挂载）、goal 服务 + round driver（供 rlm-bindings 的 goal.* host wire）。裁掉：bash/pwsh 工具及其 sandbox、子代理 fork 链路与 UI、计划模式、/goal 命令与 goal 工具、定时任务、后台任务、PTC/工作流、MCP 模型面工具（REPL 的 Python MCP 客户端经 mcp-servers.json 可用）、Web 搜索、技能系统、插件管理器、OTEL 遥测、HMR、Cordis 开发工具、pi-ai 适配器等（分组注释见 patch 文件）。恢复某项：删掉对应分组。

## 工具集

模型唯一的执行工具是 `python`（持久 REPL，kernel 内置 `bash()` 覆盖 shell 需求）。注意 kernel 内 `bash()` 由 Python 进程直接起子进程，不经过 dsh 的 bash sandbox 策略，权限等同宿主进程。

Python 工具来自 link 安装的 `@deepseek-ai/dsh-rlm-kernel-python` + `@deepseek-ai/dsh-tool-python`（连同未发布的 `@deepseek-ai/dsh-rlm-kernel` 一起 vendor 到 `packages/`，含构建产物 `lib/`）。`rlm-bindings` 已 vendor 并**已接线**（28 条 host wire：spawn/collect/goal/compact/mcp/agent_message/agent_observe/rlm_heartbeat/refine 等）：profile `package.json` 加了 `link:../../../packages/rlm-bindings` 并列入 bundles，包自带 `cordis.patch.yml` 自动 insert `rlm-bindings` 行（inject `rlmKernel/subagents/llm/sessionQuery/agents/goals/tokenMeter`，compaction 运行时经 `agentPresets.serviceFor` 从调用方 agent 的 preset 隔离域解析）。为它放开了 patch 里的 subagent 核心服务 + spawn provider + 三个模型面委托工具、goal 服务 + round driver（fork 链路、/goal 命令、goal 工具、schedule、全部 ui-* 仍裁；rlm_heartbeat 由 rlm-bindings 自带调度器实现，不依赖 schedule 插件）。continual harness 由 vendored `@deepseek-ai/dsh-rlm-harness-local` 提供具体 provider（已接线，状态存 `<dshHome>/rlm/harness/`，JSON 原子写；与 prime-agent 的 snake_case 文件不互通，跨侧只走 host 接口）。6 个移植自 prime-agent 的 Python skill 包（`goal`/`compact`/`refine`/`rlm_heartbeat`/`agent_message`/`agent_observe`）随 `rlm-kernel-python` 的 `py/skills/` 发布，profile 已配 `pythonPath` 指过去，模型在 REPL 里按需 `import goal` 等即可，宿主 Python 零第三方依赖。MCP 服务器经配置文件声明：在 `dsh-home/mcp-servers.json` 写 `{ "名称": { "type": "http", "url": "..." } }` 或 `{ "type": "stdio", "command": "..." }`（支持 env 引用、enabledTools/disabledTools 等字段，见 vendored rlm-bindings 的 README），模型在 REPL 里即可 `from rlm import mcp` 后 `mcp.list_tools("名称")` / `mcp.call_tool(...)`；文件每次请求重读，改完即生效。凭证刷新（`mcp.refresh`）与 OAuth 登录（`mcp.begin_login`）无后端，恒失败。

kernel 的 Python 侧要求宿主 `python3` 为 CPython 3.10+，且 `skill.py` 需要 `tyro`（模型 REPL 里用到的其他三方包需在宿主 Python 环境自行安装，kernel 不自动装包）。

## 已知边界

- **preset 是第二棵插件树**：`preset-standard`/`preset-minimal` 的 config 内嵌 Agent 作用域插件列表，顶层禁用够不到，已通过整体替换 preset config 同步裁剪。以后裁工具要顶层和 preset 两层一起改。
- **typert 不能裁**：Web 的 workspace/session 控制器硬依赖。
- **验证裁剪要开新会话**：旧会话历史冻结了旧工具 schema。
- web 会话用 zstd 压缩，与不压缩的 profile 不能混读同一批会话目录。

## 验证

```sh
npx -y @deepseek-ai/dsh@next --profile daimon-web --dump-config          # 最终组合树
npx -y @deepseek-ai/dsh@next --profile daimon-web --dump-config-schema   # 导入全部插件模块, 诊断应为空
```

参考：dsh 仓库 `docs/architecture.md`、`docs/cookbook/extension-cookbook.md`。API 为 pre-stable（0.1.x）。
