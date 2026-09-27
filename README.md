# my-agent

基于 DeepSeek Harness (dsh) 的自定义 Web 聊天 agent。组合方式：官方 `web` 模板裁剪 + RLM Python 工具，全部定制都在 profile 的 `cordis.patch.yml` 里。RLM 相关的两个未发布 npm 包（`dsh-rlm-kernel-python`、`dsh-tool-python`）已 vendor 到本仓库 `packages/` 下，不依赖外部源码目录。

## 运行

```sh
export DSH_HOME=/Users/bytedance/codes/open-source/my-agent/dsh-home
npx -y @deepseek-ai/dsh@next --profile myagent-web        # 输出带 token 的 URL，浏览器打开
```

首次使用在 Web 设置页填 DeepSeek API key（凭证由 credentials 插件托管）。端口 3180（patch 里 `webserver` 行可改；本机 3080 常被其他 dsh 实例占用）。

## 结构

```
my-agent/
  package.json + pnpm-workspace.yaml   # 根 workspace：为 vendored 包安装已发布的运行时依赖
  packages/
    rlm-kernel/              # vendor 自 deepseek-harness: RLM kernel 能力缝（未发布 npm）
    rlm-kernel-python/       # vendor 自 deepseek-harness: RLM Python REPL kernel（含 lib 构建产物 + py 运行时）
    tool-python/             # vendor 自 deepseek-harness: 暴露给模型的 python 工具（未发布 npm）
  dsh-home/profiles/myagent-web/
    package.json             # bundle 列表 + link:../../../packages/* 相对链接
    cordis.patch.yml         # 全部定制：功能裁剪 + preset 同步裁剪 + 端口覆盖
```

克隆后在仓库根跑一次 `pnpm install`（为 `packages/*` 安装 schemastery / cordis / dsh-tools 等已发布依赖；三个 vendored 包的 `package.json` 已把 monorepo 的 `workspace:` 协议改成发布版本号）。

## 裁剪了什么

官方 web 模板 182 行插件，patch 禁用 68 行 + 替换 2 个 preset config。保留：Web 聊天、核心 agent（`python` 工具、fs 工具、审批、设置/凭证、compaction、会话持久化）。裁掉：bash/pwsh 工具及其 sandbox、子代理、计划模式、/goal、定时任务、后台任务、PTC/工作流、MCP、Web 搜索、技能系统、插件管理器、OTEL 遥测、HMR、Cordis 开发工具、pi-ai 适配器等（分组注释见 patch 文件）。恢复某项：删掉对应分组。

## 工具集

模型唯一的执行工具是 `python`（持久 REPL，kernel 内置 `bash()` 覆盖 shell 需求）。注意 kernel 内 `bash()` 由 Python 进程直接起子进程，不经过 dsh 的 bash sandbox 策略，权限等同宿主进程。

Python 工具来自 link 安装的 `@deepseek-ai/dsh-rlm-kernel-python` + `@deepseek-ai/dsh-tool-python`（连同未发布的 `@deepseek-ai/dsh-rlm-kernel` 一起 vendor 到 `packages/`，含构建产物 `lib/`）。未装 `rlm-bindings`（硬依赖已裁掉的 subagent 服务）。kernel 的 Python 侧要求宿主 `python3` 为 CPython 3.10+，且 `skill.py` 需要 `tyro`（模型 REPL 里用到的其他三方包需在宿主 Python 环境自行安装，kernel 不自动装包）。

## 已知边界

- **preset 是第二棵插件树**：`preset-standard`/`preset-minimal` 的 config 内嵌 Agent 作用域插件列表，顶层禁用够不到，已通过整体替换 preset config 同步裁剪。以后裁工具要顶层和 preset 两层一起改。
- **typert 不能裁**：Web 的 workspace/session 控制器硬依赖。
- **验证裁剪要开新会话**：旧会话历史冻结了旧工具 schema。
- web 会话用 zstd 压缩，与不压缩的 profile 不能混读同一批会话目录。

## 验证

```sh
npx -y @deepseek-ai/dsh@next --profile myagent-web --dump-config          # 最终组合树
npx -y @deepseek-ai/dsh@next --profile myagent-web --dump-config-schema   # 导入全部插件模块, 诊断应为空
```

参考：dsh 仓库 `docs/architecture.md`、`docs/cookbook/extension-cookbook.md`。API 为 pre-stable（0.1.x）。
