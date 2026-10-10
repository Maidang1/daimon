# 「用 Harness 学 Harness」可视化交互学习系统 — 实施计划

> 版本：v1.2（2026-10-10）——教学预设自研（preset + persona）；阶段 1/2 已完成编码，待重启验收
> 目标项目：DeepSeek Harness（源码仓库 `/Users/bytedance/codes/open-source/deepseek-harness`，下称 `$REPO`）
> 计划文档落盘位置：daimon 工作区 `/Users/bytedance/codes/open-source/daimon`
> 核心原则：**尽量复用 Harness 现有能力（插件体系、Agent 预设、Web UI 扩展槽、dsh-learning-mode），不从零重造。**

---

## 0. 现状盘点（已核实）

在写计划前对本地环境做了实际核查，以下事实可作为计划的地基：

| 依赖 | 状态 | 证据 |
|---|---|---|
| Harness 源码仓库 | ✅ 已 clone 在本地 | `/Users/bytedance/codes/open-source/deepseek-harness`（apps / packages / docs / vendor 完整） |
| 教学预设机制（preset/persona） | ✅ 原生支持，可自研 | `packages/preset/agent-preset` + `agent-preset-registry` + `persona`：preset 用纯 Cordis YAML 声明，persona 行注入导师系统提示词，会话级可选 |
| Web UI 右侧栏扩展点 | ✅ 存在 | `packages/client/ui-sidebar-right`、`packages/client/ui-slots`（slot/store/renderer 三件套） |
| 插件管理 UI | ✅ 存在 | `packages/client/ui-plugin-manager`、`ui-settings-plugins` |
| 课程素材 | ✅ 已有雏形 | 工作区已有 `deepseek-harness-15day-plan.md`（15 天精细课程，含自检问题与源码路径） |
| 官方中文文档 | ✅ 60+ 篇 | `docs/*.zh.md`、`docs/subsystems/*.zh.md`、`docs/cordis-primer.zh.md` 等 |
| 模型可配置 | ✅ 原生支持 | `packages/client/ui-settings-models`（Settings → Models） |

**结论：阶段 0 的大部分前置条件已满足。教学预设不依赖任何第三方包，用 Harness 原生的 preset + persona 机制自己设计（见阶段 1.5），可以直接从环境验证开始。**

---

## 1. 目标与非目标

### 目标
学习者（即用户自己）在 Harness Web UI 内完成「阅读 → 被提问 → 动手 → 看图解 → 追踪进度」的闭环学习：

1. **能学**：Agent 以导师身份讲解 Harness 架构，引用具体源码文件与行号。
2. **能练**：留出动手练习（读代码、改配置、写最小插件），Agent 检查结果。
3. **能看见**：右侧面板显示课程导航、进度条、Mermaid 架构图、测验卡片。
4. **能追踪**：进度跨会话持久化（本地 JSON 起步，后续可换 SQLite）。
5. **能换模型**：复用原生 Settings → Models，支持 DeepSeek / 任意 OpenAI 兼容端点 / 本地 Ollama。

### 非目标（本期不做）
- ❌ 独立前端课程产品（路径 B，验证后再决策，见阶段 5）
- ❌ 多用户 / 云端进度同步 / 账号体系
- ❌ 移动端适配

---

## 2. 总体架构

```
┌──────────────────────────────────────────────────┐
│                 Harness Web UI（复用）             │
│  左：会话列表（原生）                              │
│  中：对话流 = 讲解 + 提问 + 练习反馈（原生）        │
│  右：ui-sidebar-right 扩展槽                       │
│      ├─ 📚 学习中心 Tab（章节导航 + 进度条）        │
│      ├─ 📊 架构图解 Tab（Mermaid 渲染）            │
│      └─ ✅ 测验卡片 Tab（选择题 + 即时反馈）        │
└──────────────────────────────────────────────────┘
              ↑ 插件通过 ui-slots 注册面板
┌──────────────────────────────────────────────────┐
│               Harness 运行时（复用）               │
│  · preset-learning 自研教学预设（dsh-agent-preset  │
│    + dsh-persona 注入导师人设，纯 YAML 声明）      │
│  · learning-hub 插件（本计划要开发的：进度/图解/测验│
│    数据读写 + UI 注册）                            │
│  · 工作区 = $REPO（Read-only 起步）               │
│  · learning/ 目录 = 课程大纲/练习/进度 JSON        │
└──────────────────────────────────────────────────┘
```

**落地路径**：采用「路径 A：插件增强现有 Web UI」。路径 B（独立前端 + Harness 后端）仅在阶段 2–3 验证通过后再评估。

**插件命名建议**：`dsh-learning-hub`（一个插件内聚合进度、图解、测验三个面板，避免过早拆成多包增加维护成本）。

---

## 3. 分阶段实施计划

### 阶段 0：环境准备与验证（0.5 天）

| # | 任务 | 产出 / 验收标准 |
|---|---|---|
| 0.1 | 确认 Node ≥ 22.19 / pnpm；在 `$REPO` 下 `pnpm install && pnpm build` | build 成功 |
| 0.2 | 准备模型凭证：DeepSeek API Key，或本地 Ollama / OpenAI 兼容端点 | Settings → Models 里可选中并发对话成功 |
| 0.3 | 启动 Web 端：`pnpm start:web`（或 `npx @deepseek-ai/dsh web`） | `http://127.0.0.1:3180` 可对话 |
| 0.4 | 把 `$REPO` 设为工作区，权限 **Read-only** | Agent 能读源码、不能写 |

**产出**：可对话、能读源码、右侧预览面板可用的学习环境。（教学预设在阶段 1 自己设计，不在本阶段依赖任何外部插件）

### 阶段 1：基础教学体验 + 自研教学预设（1.5–2 天）

目标：先跑通「边读源码边被提问」的最小闭环，并把导师人格沉淀为**自己设计的 preset**，不靠第三方教学插件。

**第一步：提示词验证（不写代码，半天）**

| # | 任务 | 产出 / 验收标准 |
|---|---|---|
| 1.1 | 用附录 A 提示词开启学习会话，从第 0 章开始 | Agent 按规则提问并等待回答 |
| 1.2 | 验证四项能力：① 引用源码文件:行号讲解 ② 主动提问并等待 ③ 留练习空白 ④ 根据回答调整深度 | 四项各至少出现一次 |
| 1.3 | 迭代提示词模板，把效果差的规则改掉 | 定稿 `learning/prompts/tutor.zh.md` |
| 1.4 | 在工作区建 `learning/` 目录骨架（见 §4） | 目录 + 第 0、1 章大纲落盘 |

**第二步：把提示词固化成自研 preset（1 天）**

机制（已核实源码）：`@deepseek-ai/dsh-agent-preset` 用普通 Cordis YAML 声明一个 preset（`id` + `plugins` 子插件列表）；在其 `plugins` 内挂 `@deepseek-ai/dsh-persona` 行，用 `prefix` 注入导师人设（即 1.3 定稿的提示词）；新建/覆盖 preset 是 bundle 补丁，经 `plugin_manager` 安装进 profile；会话在 `agent-preset-registry` 里选择该 preset。参考资料：`packages/preset/agent-preset/README.zh.md`、`agent-preset-registry/README.zh.md`、`persona/README.zh.md`。

| # | 任务 | 产出 / 验收标准 |
|---|---|---|
| 1.5 | 编写 `preset-learning` 声明：preset 行 + persona 行（`prefix` = 导师提示词），必要时裁剪工具集（学习场景只需读工具 + 写 `learning/` 的能力） | YAML 片段落盘 `learning/preset-learning.yaml` |
| 1.6 | 经 `plugin_manager` 把 preset 安装进 web profile（或用 Creator 模式辅助生成补丁，人工 review 后安装） | 新建会话的 preset 列表里出现「学习模式」 |
| 1.7 | 用「学习模式」preset 开新会话，重跑 1.2 的四项验证 | 四项全部通过，且行为与手写提示词阶段一致或更好 |

**产出**：定稿的导师提示词 + **自研 `preset-learning` 教学预设**（可随仓库版本维护）+ 课程目录骨架。

### 阶段 2：可视化增强 — 开发 `dsh-learning-hub` 插件（2–4 天）

目标：右侧栏出现三个学习面板。优先手写最小插件（可控），Creator 模式生成作为备选加速手段。

| # | 任务 | 产出 / 验收标准 |
|---|---|---|
| 2.0 | 读 `packages/client/ui-slots` 与 `ui-sidebar-right` 源码 + `docs/` 中插件/客户端扩展文档，搞清面板注册机制 | 写出一页机制笔记（注册 API、生命周期、HMR 行为） |
| 2.1 | **进度面板**：注册「学习中心」Tab；章节 checklist + 总进度条；数据读写 `learning/progress.json` | 勾选章节 → 刷新后进度仍在 |
| 2.2 | **图解面板**：Mermaid 渲染区域；Agent 侧提供写图入口（插件服务或约定文件 `learning/diagrams/*.mmd`） | Agent 写入一张架构图 → 面板实时渲染 |
| 2.3 | **测验卡片**：题干 + 4 选项 + 提交即时反馈（对错 + 解析）；结果追加到 `learning/quiz-log.jsonl` | 答题 3 次，log 有 3 条记录且 UI 反馈正确 |
| 2.4 | 安装进 web profile 并验证热加载/重启生效；挂到 `ui-plugin-manager` 可见 | 插件管理页可启用/禁用 |

**Creator 模式用法（备选）**：用附录 B/C 提示词让 Agent 生成初版源码 → **人工 review 后**再安装（生成质量不稳定，必须检查）。手写与生成可以混用：机制搞懂后手写骨架，让 Creator 补样式。
**产出**：`dsh-learning-hub` 插件 v0.1，含进度/图解/测验三面板。

### 阶段 3：课程内容结构化（3–5 天）

把学习材料沉淀为插件可渲染、Agent 可引导的课程。

| # | 任务 | 产出 / 验收标准 |
|---|---|---|
| 3.1 | 以现有 `deepseek-harness-15day-plan.md` 为蓝本，改写成 8 章课程（见 §4），每章一个 Markdown：大纲 + 讲解要点 + 源码锚点 + 练习 + 测验题（JSON） | `learning/chapters/00-07*.md` 齐 |
| 3.2 | 进度面板改为读取 `learning/` 目录渲染真实章节（替换 2.1 的硬编码） | 面板展示 8 章，勾选状态持久化 |
| 3.3 | 每章配 1 张 Mermaid 架构图（可由 Agent 生成后人工校正） | `learning/diagrams/` 8 张图 |
| 3.4 | 导师提示词升级：按 `learning/` 目录结构引导，答完测验自动更新 `progress.json` | 完整走完第 0、1 章，进度自动推进 |

**产出**：8 章结构化课程 + 插件与内容打通。

### 阶段 4：交互深化（可选，3–7 天，按优先级排序）

| 优先级 | 功能 | 说明 |
|---|---|---|
| P0 | 进度持久化增强 | `progress.json` → SQLite（复用 `packages/storage` 能力），跨会话/跨工作区 |
| P0 | 源码导航联动 | 面板点击知识点 → 定位文件并在右侧文档预览打开（复用 `ui-sidebar-documentpreview` / 文件预览） |
| P1 | 动手练习校验 | 用户写最小插件/改配置，Agent 运行检查脚本判定对错 |
| P1 | 自适应难度 | 按 `quiz-log.jsonl` 正确率调整提问深度（规则版即可，先不上模型判断） |
| P2 | 多模型快捷切换 | 学习会话内快速切 DeepSeek / 本地模型（原生设置已支持，做入口优化即可） |

### 阶段 5：独立前端（可选，产品化阶段）

触发条件：阶段 2–3 验证「有人真的用它学完了 ≥ 3 章」。
方案：Next.js/Vite 独立课程前端 + Harness Python SDK / JSON-RPC 调 Agent；前端负责课程导航/进度/可视化，Agent 负责讲解与评估。**本计划不展开，届时另立文档。**

---

## 4. 课程内容结构（章节 → 真实源码映射）

工作区目录约定（实际落在 daimon 项目 `/Users/bytedance/codes/open-source/daimon/learning/`，与被学习的 `$REPO` 源码仓库分离）：

```
learning/
├── chapters/          # 每章大纲 + 练习
│   ├── 00-what-is-harness.md
│   ├── 01-cordis-plugin.md
│   ├── ...
├── diagrams/          # Mermaid 图源（.mmd）
├── quizzes/           # 每章测验题（JSON）
├── prompts/tutor.zh.md
├── preset-learning.yaml  # 自研教学预设（dsh-agent-preset + dsh-persona 声明）
└── progress.json      # 进度持久化（插件读写）
```

| 章 | 主题 | 源码锚点（已核实存在） |
|---|---|---|
| 0 | 什么是 Agent Harness | `$REPO/README.zh.md`、`docs/architecture.zh.md` |
| 1 | 一切皆插件 + Cordis 基础 | `vendor/cordis`、`docs/cordis-primer.zh.md`、`apps/cli/src/plugin.ts`、`profile-boot.ts` |
| 2 | 核心循环 agent loop | `packages/core/agent-loop`（`agent.ts → assistant-stream.ts → tool-calls.ts → inbox.ts`）、`docs/agent-lifecycle.zh.md` |
| 3 | 会话与记忆 | `packages/session/session-persistence-jsonl`、`session-projection`、`session-format-*`（v0→v4 迁移链） |
| 4 | 工具系统 | `packages/fs/tool-fs`、`fs-sandbox`、`packages/shell/bash-local`、`packages/core/tools` |
| 5 | 模型适配 | `packages/llm/llm`、`llm-deepseek`、`llm-pi-ai`、`token-meter` |
| 6 | 插件开发实战 | 对照 `dsh-learning-hub` 自身源码 + `docs/cordis-tutorial/` |
| 7 | 综合练习：用 Harness 改自己 | 给 learning-hub 加一个小功能（如错题重练） |

> 第 6 章是「元学习」亮点：学习者读的就是自己正在用的学习插件的源码。

---

## 5. 关键技术点映射

| 能力 | 实现方式 | 关键位置 |
|---|---|---|
| 教学提问/导师人格 | **自研 preset**：`dsh-agent-preset` 声明 + `dsh-persona` 注入导师人设；提示词内容为附录 A 定稿 | `packages/preset/agent-preset*`、`persona`、`learning/preset-learning.yaml` |
| 可视化面板注册 | 插件经 ui-slots 注册到右侧栏 | `packages/client/ui-slots`、`ui-sidebar-right` |
| 图解 | Mermaid 渲染 + `.mmd` 文件约定 | `learning/diagrams/` |
| 进度追踪 | 插件读写本地 JSON，后期 SQLite | `learning/progress.json`、`packages/storage` |
| 模型可配置 | 原生 Settings → Models | `packages/client/ui-settings-models` |
| 源码阅读 | 工作区=`$REPO` + 文件预览面板 | `ui-sidebar-files`、`ui-sidebar-documentpreview` |
| 权限控制 | Read-only 起步，练习时按会话切 Workspace-write | 审批策略设置 |
| 插件管理 | 原生插件管理页启用/禁用/锁版本 | `ui-plugin-manager` |

---

## 6. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| DSH 是开发者预览版，插件/客户端 API 可能变 | 高 | 锁定插件版本；`dsh-learning-hub` 源码放本仓库内随版本升级；机制笔记（2.0 产出）记录所依赖的 API 面 |
| Creator 模式生成的插件质量不稳 | 中 | 生成后必须人工 review 再安装；优先手写骨架，Creator 只做样式/样板填充 |
| Agent 误改学习仓库源码 | 中 | 学习会话全程 Read-only；动手练习在独立 scratch 目录或单独 profile 进行 |
| 长会话上下文/token 消耗 | 中 | 每章开新会话，进度靠 `progress.json` 接续；提示词里要求讲解简洁 |
| 自研 preset 依赖的 preset/persona API 在预览版中变化 | 中 | 预设只是 YAML 声明，升级时对照 `packages/preset/*/README.zh.md` 调整；导师人设文本独立于机制存在 `learning/prompts/`，机制坏了也能手工粘贴使用 |

---

## 7. 附录：起步提示词模板

### 附录 A · 开启学习会话

```
你是我的 DeepSeek Harness 导师。工作区是官方源码仓库。
请按以下规则引导我：
1. 先问我当前熟悉程度（入门/进阶）。
2. 讲解时结合具体源码文件和行号。
3. 讲完一个知识点后主动提问，等我回答再继续。
4. 适当留下小练习让我动手。
5. 用中文讲解。

现在从第 0 章开始：什么是 Agent Harness，以及「一切皆插件」是什么意思。
```

### 附录 B · 生成学习面板（Creator 模式）

```
在右侧侧边栏添加一个「学习中心」插件，包含：
- 章节列表（可标记完成）
- 当前进度条
- 一个可展开的区域用来显示 Mermaid 图
先写出完整源码，再帮我安装并启用。
```

### 附录 C · 生成测验组件（Creator 模式）

```
做一个简单的选择题交互组件，放在右侧侧边栏：
- 显示题目和 4 个选项
- 用户选择后立即给出对错反馈和解释
- 记录答题结果到本地文件
先生成完整可安装的插件源码。
```

---

## 8. 本周执行顺序（里程碑 checklist）

- [ ] **今天**：阶段 0 全部 + 阶段 1 的 1.1/1.2（手写提示词跑通教学，验证四项能力）
- [ ] **明天**：阶段 1.3/1.4（提示词定稿 + `learning/` 骨架）→ 1.5/1.6（自研 preset-learning 并安装）
- [ ] **后天上午**：阶段 1.7（preset 会话复验）→ 阶段 2.0（读 ui-slots 机制，写笔记）
- [ ] **第 4 天**：阶段 2.1/2.2（进度面板 + 图解面板）
- [ ] **第 5 天**：阶段 2.3/2.4（测验卡片 + 安装验证）→ 插件 v0.1 完成
- [ ] **第 6–8 天**：阶段 3（8 章课程内容 + 面板打通）
- [ ] **下周起**：按优先级做阶段 4；阶段 5 视验证结果再决策

**完成定义（DoD）**：一位从未读过 Harness 源码的学习者，仅靠该系统的引导，能在 8 章内完成第 6 章「独立写出一个最小插件」的练习并通过 Agent 校验。

---

## 9. 实现状态（2026-10-10 更新）

已完成阶段 1（内容侧）与阶段 2（插件开发）的全部编码：

| 产出 | 位置 |
|---|---|
| 导师提示词（定稿 v1） | `daimon/learning/prompts/tutor.zh.md` |
| 自研教学预设 | `daimon/learning/preset-learning.yaml`（已追加进 daimon-web profile 的 cordis.patch.yml） |
| 8 章课程大纲（含源码锚点/自检问题/练习） | `daimon/learning/chapters/00–07` |
| 8 章测验题（服务端判分，答案不下发浏览器） | `daimon/learning/quizzes/ch00–07.json` |
| Mermaid 图解 ×2 | `daimon/learning/diagrams/` |
| 进度持久化文件 | `daimon/learning/progress.json` |
| 机制笔记（插件依赖的 API 面，升级对照用） | `daimon/learning/mechanism-notes.md` |
| **dsh-learning-hub 插件**（host HTTP API + 右侧栏三面板，已通过 host 半冒烟测试） | `daimon/learning/plugin/dsh-learning-hub/` |

安装状态：插件已加入 `daimon-web` profile 的 bundles，preset 已进 profile 补丁。
**待做：重启 `dsh web`（`pnpm start`，即 `DSH_HOME="$PWD/dsh-home" node client/runtime/... --profile daimon-web`）后生效**，随后做浏览器端验收（三面板可见、勾选持久化、图解渲染、测验判分）。

与原计划的一处偏差：三个面板实现为同一插件下的三个右侧栏 Tab（学习中心/架构图解/学习测验），功能与验收标准不变。
