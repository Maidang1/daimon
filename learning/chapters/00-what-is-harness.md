# 第 0 章 · 什么是 Agent Harness

> 预计用时：1.5–2 小时 ｜ 前置：无 ｜ 仓库：`/Users/bytedance/codes/open-source/deepseek-harness`（下文 `$REPO`）

## 🎯 学习目标

完成本章后，你能够：

1. 用一句话说清 Agent Harness 解决什么问题，和「裸调 LLM API」的本质区别。
2. 说出 DSH 的三层结构（`apps/` / `packages/` / `vendor/`）各自的角色，以及 331 个包的组织方式。
3. 解释「一切皆插件」的字面含义，并在 `standard.patch.yml` 里指出证据。
4. 描述 profile / bundle / patch 三层装配关系，知道自己机器的启动配置树怎么查。
5. 眼熟「轮次流程」官方图，为第 2 章精读 agent loop 打底。

---

## 💡 0.0 导入：一段你只能看不能用的响应

先做一个思想实验。你「裸调」LLM 的 Messages API：

```python
response = client.messages.create(model="k3", messages=[
    {"role": "user", "content": "总结一下我电脑上的 README.md"}
])
```

模型想帮你，但它返回的不是总结，而是一个**请求**：「请调用工具 `read_file`，参数 `{path: "README.md"}`，把结果给我」。问题来了：

- 模型厂商的服务器**碰不到你的磁盘**——工具只能由你本机的某个程序执行
- 执行完还不算完：结果要追加进对话历史，**再次调用模型**，它可能又要调下一个工具
- 对话太长要压缩、危险操作要你点头审批、关掉窗口要能恢复……

这一整套「包住模型、替它干活」的程序就是 **Agent Harness**。

> 📌 **一句话**：LLM 是大脑，Harness 是身体——循环（agent loop）、手（工具）、记忆（会话持久化）、安全带（审批与沙箱）都在 Harness 里。

DSH 的官方自我定位写在 [README.zh.md:5](</Users/bytedance/codes/open-source/deepseek-harness/README.zh.md:5>)：

> DeepSeek Harness（`dsh`）是由 DeepSeek AI 开发的开源 agent harness（智能体框架）。

注意下一行：它构建于**「一切皆插件」**的架构之上，由 Cordis 驱动，并引用论文 *A Programming Paradigm for Spatiotemporal Composability*——「时空可组合性」是 Cordis 的设计哲学，第 1 章会正面拆解它。

---

## 📖 0.1 三层结构：表层、能力、地基

DSH 是一个 pnpm monorepo：**331 个包**、67 篇子系统文档。别被数字吓到，它的顶层只有三个目录角色：

| 目录 | 角色 | 例子 |
|---|---|---|
| `apps/` | **表层（surface）**：用户摸得到的壳 | `cli`、`web-frontend`、`desktop`（Electron） |
| `packages/` | **能力层**：按域分组的能力包（**分组目录**，不是单个包！） | `packages/core/`（agent 循环）、`packages/session/`、`packages/llm/`、`packages/fs/`、`packages/client/` |
| `vendor/` | **地基**：内化的基础设施 | cordis（DI/插件内核）、schemastery（schema）等 |

关键推论——**「换 UI 不换大脑」是成立的**：CLI、Web GUI、桌面应用只是 `apps/` 下的不同壳，共享同一套 `packages/` 能力。你在 Web 上和 agent 聊天时经历的一切（循环、工具、审批、持久化），CLI 里同样发生。

> ⚠️ **真实踩坑**（环境搭建那天遇到的）：`packages/` 是分组目录，构建系统靠 `packages/*/*` 通配发现包。如果某个目录残留了已删除包的旧 `lib/` 产物（僵尸目录），构建会拿过期代码去打包，报出莫名其妙的 `MISSING_EXPORT`。口诀：**构建报错先查僵尸目录**（`for d in packages/*/*/; do [ ! -f "$d/package.json" ] && echo "$d"; done`）。

官方「核心包」清单（[architecture.zh.md:55](</Users/bytedance/codes/open-source/deepseek-harness/docs/architecture.zh.md:55>)），建议混个眼熟——它们就是后面每章的主角：

| 包 | 职责 | `ctx` 键 | 本课程章节 |
|---|---|---|---|
| `core/session` | 仅追加的会话事件日志和内存存储 | `ctx.sessions` | 第 3 章 |
| `core/system-prompt` | 提示词片段与工具 schema 的组装 | `ctx.systemPrompt` | 第 2 章 |
| `core/tools` | 工具注册表 + 带把关的执行管线 | `ctx.tools` | 第 4 章 |
| `core/agent` | `Agent` 接口、活跃 agent 注册表、`agent/*` 事件 | `ctx.agents` | 第 2 章 |
| `core/agent-loop` | 默认驱动器（主循环实现） | `ctx.agentLoop` | 第 2 章 |
| `llm/llm` | 消息与流式词汇表、适配器 seam | `ctx.llm` | 第 5 章 |

---

## 📖 0.2 「一切皆插件」：不是口号，是字面事实

打开 [architecture.zh.md:9](</Users/bytedance/codes/open-source/deepseek-harness/docs/architecture.zh.md:9>)，第一句就是：

> 产品的每一部分都是插件，包括模型适配器、工具注册表、会话日志，以及 **agent loop 本身**，因此每个都可以从配置替换。

这句话的分量在于：连「心脏」（agent loop）都不是特权内核，而是从配置挂上去的插件。没有任何部分需要你「打补丁改源码」才能替换——**扩展 dsh 的方式是把插件挂到其他插件旁边**。

**证据 1：一个 preset 就是一张插件清单。**
打开 [packages/bundle/web-app/presets/standard.patch.yml:1](</Users/bytedance/codes/open-source/deepseek-harness/packages/bundle/web-app/presets/standard.patch.yml:1>)，你会看到 standard 模式的完整定义：`persona`（人设）、`tool-bash`（按平台用 `!!js` 条件禁用）、`tool-fs`、`tool-subagent`……36 处 `tool-*` 引用。你在设置页切换「标准 / 极简」模式，切换的就是这张清单。

**证据 2：本课程自己就是插件。**
你右侧的「学习中心」面板（`@local/dsh-learning-hub`）和官方工具用**完全相同**的机制装配：host 半提供 HTTP API、client 半注册侧边栏 tab，经 profile 的 `cordis.patch.yml` 挂载。学完第 6 章你就能写出同款。

**证据 3：配置树可以完整 dump。**

```bash
cd $REPO && pnpm dsh --profile web --dump-config
```

打印出的每一个条目，都可以被你自己的 patch 替换（[architecture.zh.md:40](</Users/bytedance/codes/open-source/deepseek-harness/docs/architecture.zh.md:40>)）。

---

## 📖 0.3 Profile / Bundle / Patch：启动时装配的三层

运行中的 `dsh` 是一棵**插件树**，由启动时按序叠加的各层组合而成（[architecture.zh.md:13](</Users/bytedance/codes/open-source/deepseek-harness/docs/architecture.zh.md:13>)）：

```text
空条目列表 []
  ↓ 第 1 层：profile 声明的有序 bundle 列表（package.json 的 dsh.profile.bundles）
  ↓ 第 2 层：每个 bundle 自己的 patch（package.json 的 dsh.bundle.patch）
  ↓ 第 3 层：profile 的 cordis.patch.yml（用户级覆盖）
  ↓ 第 4 层：--patch 命令行 overlay
= 最终配置树 → Cordis 按树激活插件
```

- **Profile**：Harness home 里的具名组装。官方随附 `web` / `headless` / `sdk` / `sdk-minimal` / `acp`；你正在用的 `daimon-web` 就是自定义 profile
- **Bundle**：插件配置 + 代码的分发格式。`dsh-base` 是几乎所有 profile 共享的第一层（模型适配器、工具、持久化、沙箱、审批）；`dsh-web-app` 往上叠加浏览器应用
- **Patch**：按 `id` 定位条目做操作——替换整个 config、`insert` 新条目、`disabled: true` 裁掉

> 🔍 真实例子：我们的 `daimon-web` profile 里就用了全部三种操作——`disabled: true` 裁掉 jobs/workflow 等功能块、`insert` 挂入 skill-office 和 learning-hub、覆写 webserver 端口为 3180（见 `dsh-home/profiles/daimon-web/cordis.patch.yml`）。

---

## 📖 0.4 轮次流程预览：全课程最重要的一张图

[architecture.zh.md:83](</Users/bytedance/codes/open-source/deepseek-harness/docs/architecture.zh.md:83>) 给出了官方的轮次（turn）流程定义，先记住两个核心概念：

> **一个步骤（step）= 一次模型请求 + 它调用的工具。一个轮次（turn）= 零个或多个步骤：领取首条输入时打开，不再欠任何工作时关闭。**

```text
turn/start
  claim 输入 → 组装提示词+工具 schema
  agent/pre-step (可拒绝/改写)
    step/start
    agent/request → prepareCall
    流式请求 → agent/assistant-stream (chunk*)
    assistant/message          ← 模型说完话
    tool/call → tools/execute → tool/result*   ← 有工具就执行
    step/end
    还欠工作？ → 下一个 step
turn/end
```

现在只需眼熟三个形状：**turn 套 step**、**stream 产消息**、**tool 欠账触发下一步**。第 2 章我们会拿着这张图逐行对源码。右侧栏「架构图解」面板里有对应的 Mermaid 版本（`ch00-architecture`）。

---

## ⚠️ 常见坑（本章相关）

1. **僵尸目录幽灵构建**：升级/切分支后删除残留 `lib/`、`node_modules`（见 0.1 的坑）
2. **用 npm/yarn 而不是 pnpm**：本仓库强制 pnpm（workspace + 链接协议），混用会产生错误的 node_modules 布局
3. **改了 `packages/` 没重新 build**：`pnpm dsh` 直接用已构建产物，不会自动重建（`pnpm dev:web` 才有 watch）
4. **在 `cordis.yml` 上直接改**：那是空模板，要改 `cordis.patch.yml`（分层设计的意义就在于此）

---

## ✋ 自检问题

1. `apps/`、`packages/`、`vendor/` 三层分别是什么角色？「换 UI 不换大脑」为什么成立？
2. 会话历史落盘在哪里、是什么格式？（提示：找 `packages/session/session-persistence-jsonl`，第 3 章细讲）
3. step 和 turn 的关系是什么？一个 turn 里最少有几个 step？
4. `pnpm dsh` 和 `pnpm start:web` 的入口是同一个文件吗？（去 `package.json` 验证）
5. 想给所有会话加一个新工具，应该改哪一层：bundle patch、profile patch 还是 `--patch`？分别什么时候选？

## 🛠 练习

- **练习 0.1（读，10 分钟）**：在 `packages/bundle/web-app/presets/standard.patch.yml` 里数出 standard preset 挂载了多少个 `tool-*` 插件，说出其中任意 3 个的用途。进阶：`minimal.patch.yml` 和它的差异是什么？
- **练习 0.2（跑，15 分钟）**：`cd $REPO && pnpm dsh --profile web --dump-config | head -50`，对照 0.3 的分层图，找出输出里哪些条目来自 bundle、哪些来自 profile patch。
- **练习 0.3（观察，10 分钟）**：启动 web 端完成一次真实对话（比如让它读一个文件并总结），观察右栏、审批弹窗、工具渲染，记录你看到的三个 UI 区域。
- **练习 0.4（验证，5 分钟）**：回答自检问题 4——`cat package.json | grep -A2 '"dsh"\|"start:web"'`，确认两个命令是否同一入口。

## 📝 测验

右侧栏「学习测验」面板选择 **第 0 章**（6 题），答完会即时判分并显示解析。

## 📚 延伸阅读

- [README.zh.md](</Users/bytedance/codes/open-source/deepseek-harness/README.zh.md>) — 项目定位
- [docs/architecture.zh.md](</Users/bytedance/codes/open-source/deepseek-harness/docs/architecture.zh.md>) — 本章的官方源，全文值得二刷
- [docs/glossary.zh.md](</Users/bytedance/codes/open-source/deepseek-harness/docs/glossary.zh.md>) — 术语表，遇到生词就查
- [docs/development.zh.md](</Users/bytedance/codes/open-source/deepseek-harness/docs/development.zh.md>) — 环境搭建细节

---

> ✅ 学完后到「学习中心」面板勾选本章完成。下一章：**第 1 章 · 一切皆插件 + Cordis 基础**——拆开这颗驱动一切的插件内核。
