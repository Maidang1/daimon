# finance-board 重设计：AI 产品本位 —— 首页即 AI 投资助手

## 设计稿（视觉基准，先看这个）

pen.dev 设计稿：`packages/rlm-kernel-python/py/skills/finance/01.pen`（VS Code Pencil 扩展打开）。有效画板四张（旧版已删除）：

1. **主页·AI 对话首页**（默认页）：左侧边栏（渐变 logo + 新对话渐变按钮 + 最近会话列表 + 底部导航：金融看板/热点资讯/官方界面）＋ 主区 760px 居中列（问候语「晚上好，我是 daimon」→ 大提问框（品牌描边 + 深度思考 chip + 渐变发送钮）→ 三个快捷建议 chip → **今日主要指数**（纳指100/标普500/道指/纳指生物科技，等宽大数字 + 涨跌徽章）→ **与你的持仓相关**（AI 精选新闻卡：标题 + 影响徽章（偏利好/关注）+ 来源时间 + 关联基金 chip + 「问问 daimon：这条新闻对我的持仓有什么影响？」动作行））
2. **主页·对话进行中**：同侧边栏；消息流 760 居中（渐变头像 + 开放排版 + 内嵌迷你指数卡 + 工具卡片（状态色条+耗时）+ 流式光标 ▍ + 用户气泡），输入框吸底，生成中显示「■ 停止生成」
3. **金融看板页**：同侧边栏（「金融看板」高亮），原看板完整内容（KPI 行 + 基金预测网格 + 四 tab）作为主区，看板退为二级页面
4. **基金详情·下钻**：同侧边栏。返回链接 ← 返回金融看板；基金头部（名称 19/700 + 代码 + QDII/待收盘/跟踪指数 chips；右侧大净值 + 盘中估算徽章）；持仓 KPI ×4（持有份额/成本/收益（渐变顶线）/今日估算）；**净值走势大卡**（渐变面积 + MA20 琥珀色参考线 + 图例 + 区间切换 1月/3月/6月/1年）；双列：预测与信号（R²/命中率/MA20 chips）＋ RBSA 跟踪篮子（权重条形）；相关新闻（影响徽章）；**底部常驻「追问 dock」**：基金专属建议 chips（为什么跑输纳指？/ 继续定投还是止损？/ 和 012752 有什么区别？）+ 带基金上下文的提问框（占位「对 大成标普500(008401) 继续追问…」）——下钻页就地深入分析，不用跳走

## Context（为什么重做）

finance-board 现状是纯内联样式的暗色数据看板 + 右侧聊天抽屉。用户两轮反馈：① 没有设计感和 AI 感；② **AI 感 = 默认就是一个 AI 产品、突出 AI 能力——主页面应该是聊天入口，每天推荐主要指数，并根据持仓推荐今天的相关新闻**。

因此产品定位从「数据终端 + 聊天抽屉」改为「**AI 投资助手 + 数据看板作为二级页**」。

**用户确认的决策**：
1. 主页 = AI 对话首页（方向已确认，继续深化）
2. 首页「今日指数 + 持仓相关新闻」数据 = **agent 每日生成简报**（briefing.json），首页渲染，点新闻转成对话 prompt
3. dsh 官方聊天/轨迹界面不能作组件库复用（npm 只导出 cordis 插件入口、深度耦合、不发源码）→ 聊天 UI 自建 + 「官方界面」入口深链 `/index.html` 看完整 Trajectory
4. 视觉 = 对齐 dsh 官方 dsw 暗色 token（值已从 dsh-client-ui-theme 0.1.7-rc.2 提取，并存为 01.pen variables）

**技术事实**（已核实）：
- esbuild（`scripts/build-terminal.mjs`）原生支持 CSS import：`import './terminal.css'` 自动产出 `lib/terminal/app.css`，构建脚本零改动；后端 `src/index.ts` 用 `serveTerminalAsset()` 加一条 `/terminal/app.css` 路由（8 行）。
- `charts.tsx` 用 SVG attribute 设色，不支持 `var()`，图表色保留 hex。
- 协议层 `src/terminal/dsh/{rpc,mux,events,sessions}.ts`（~800 行，钉 dsh 0.1.7-rc.2）与数据层 `src/client/api.ts`：**不动**。sessions store 已有 list/select/create/prompt/follow 全部能力，侧边栏会话列表直接复用。
- job 机制（`POST /finance/api/jobs` + `JOB_ACTIONS` + Python runner）可直接扩展一个 `daily_briefing` action。

## 一、信息架构（新）

```
┌────────────┬──────────────────────────────────────────┐
│ 侧边栏 250px│  主区（随视图切换）                        │
│ ◆ daimon   │                                          │
│ [+ 新对话]  │  home(默认): 问候+提问框+建议+指数+新闻     │
│ 最近对话    │  chat:       消息流760居中+输入框吸底       │
│  ·会话1 ●  │  board:      金融看板（原 TerminalPanel）   │
│  ·会话2    │                                          │
│ ─────────  │                                          │
│ 金融看板    │  顶行右侧: ● 已连接 pill                   │
│ 热点资讯(链)│                                          │
│ 官方界面(链)│                                          │
└────────────┴──────────────────────────────────────────┘
```

- 视图状态：`view: 'home' | 'chat' | 'board' | 'fund'`（fund 携带 `fundCode`），`useState` + `localStorage('fb.view')`；**无 react-router**（保持现有零依赖）。点侧边栏会话 → `selectSession` + 切 `chat`；发消息/点新闻/点建议 → 切 `chat`；点基金卡/持仓行 → 切 `fund`；⌘/Ctrl+B 在 home ↔ chat 间切换。
- 首页不是空状态替代品——**home 就是默认落地页**；`chat` 是有消息后的进行态。原「空状态 + 建议 chips」概念并入 home。
- 「热点资讯」「官方界面」为链接项：官方界面 → `/index.html`（新标签，同源 cookie 已鉴权）；热点资讯 → 切 board 的热点 tab（或直接锚到 dashboard）。

## 交互细则（按功能）

**侧边栏**
- 「+ 新对话」→ `sessions.createSession()` 后切 `chat`；会话项 click → `selectSession` + 切 `chat`；运行中的会话名前带品牌色 ●；当前活动会话高亮 `--fb-bg-3`。
- 底部导航 hover `--fb-hover`；「官方界面」新标签打开 `/index.html`。

**主页（home）**
- 提问框 Enter 发送（Shift+Enter 换行、输入法合成中不发送——沿用现有 composer 逻辑）；无活动会话时先 `createSession` 再发，随后切 `chat`。
- 建议 chip → 同上路径直接发对应 prompt。
- 新闻卡整卡可点（hover 描边 `--fb-line-2` + 上浮 1px）→ 发送该新闻的 `prompt` 字段（briefing.json 自带）并切 `chat`。
- 指数卡 click → 发送「今天{name}为什么{涨/跌}？对我持仓有什么影响？」；简报 404 → 新闻区降级为「今日简报未生成」卡 + 主按钮「让 daimon 生成」（触发 `daily_briefing` job，运行中显示三点动画，生成后 5 秒轮询自动刷新）。

**对话页（chat）**
- 消息流自动吸底（用户上滚则释放，沿用现有 pinned 逻辑）；工具卡默认折叠、点击展开输出（前 12 行截断）；审批/提问 banner 置顶毛玻璃，必须应答否则 agent 卡死（现有逻辑不变）。
- 生成中：composer 右侧变「■ 停止生成」；header `⇱` 新标签开 `/index.html` 看完整轨迹。

**金融看板页（board）**
- 基金卡/持仓行 click → **切 `fund` 下钻**（卡片加 `cursor:pointer` 与 hover 上浮提示可点）。
- 「生成日报/深度快照」→ 202 后横幅显示运行态（三点动画），成功 toast（毛玻璃、底部居中 2.5s），失败 error 横幅可展开 traceback；「记一笔」modal（圆角 16 + 阴影，买卖切换涨跌色徽章，提交成功 toast）。
- 5 秒 mtime 轮询不变；`!loaded` 渲染骨架屏（KPI×4 + 卡片×6 shimmer）。

**基金下钻（fund）**
- ← 返回金融看板（回 `board`，保持原 tab）；区间切换为本地 state（1月/3月/6月/1年），切换时图表重取数（若 snapshot 只有单一窗口，先禁用并标注，数据通路后补）。
- 新闻卡 click → 携带该基金上下文发 prompt。
- **追问 dock 常驻底部**：建议 chips 一键发；输入发送时自动携带基金上下文（prompt 前缀注入「关于 {name}({code})：」，对用户不可见地拼装，或直接可见前缀），有活动会话则在其中继续，无则新建——下钻分析对话沉淀在会话里，之后可从侧边栏回来。
- 数据来源：优先从现有 `ui_snapshot.json` + `holdings.json` 前端过滤（净值历史、份额成本已有）；RBSA 篮子为后续数据工作（daily_job 扩展），未就绪时该卡片显示「跟踪篮子待配置」空态 + 「让 daimon 现在配置」按钮（发 prompt）。

## 二、每日简报（新数据通路）

**产出侧**：
- `JOB_ACTIONS` 新增 `daily_briefing`：Python runner 调 finance skill 生成 `dsh-home/finance/state/briefing.json`。
- finance skill 侧新增 `finance.briefing()`（`packages/rlm-kernel-python/py/skills/finance/`）：汇总主要指数行情（复用现有行情通道/RBSA 篮子：^NDX、SPX 等权 RSP、纳指生物科技、道指）＋ 持仓相关新闻。**新闻的筛选与影响解读由 agent 完成**：skill 只负责拉原始候选（热点/资讯源），日报心跳任务（dsh-home 运行手册里的交易日 9:30 心跳巡检）让 agent 调 skill 取候选、筛选 3-6 条、写影响解读与关联基金，落盘 briefing.json。
- briefing.json 结构：
```json
{ "date": "2026-09-30", "greeting": "晚上好", "indices": [{"name":"纳斯达克100","value":24512.34,"pct":1.24}],
  "news": [{"title":"…","source":"华尔街见闻","time":"2小时前","impact":"bullish|watch|bearish","funds":["建信纳指100"],"prompt":"解读这条新闻对我持仓的影响：…"}],
  "suggestions": ["生成今日投资日报","复盘 024239 的定投决策","扫描我持仓的风险敞口"] }
```

**消费侧**：
- 新 API：`GET /finance/api/briefing`（`src/index.ts`，读 state/briefing.json，无则 404 → 前端降级为「简报生成中/今日简报未生成，点这里让 daimon 生成」按钮，点击触发 `POST /finance/api/jobs {action:'daily_briefing'}`）。
- 前端 `api.ts` 加 `fetchBriefing()` + 类型；复用现有 5 秒 mtime 轮询刷新。
- 点击新闻卡/建议 chip → `sessions.sendPrompt(news.prompt)` + 切 chat 视图（若无活动会话先 `createSession`）。

## 三、设计 token（新增 `src/terminal/terminal.css`，前缀 `--fb-`，值对齐 dsh 暗色；与 01.pen variables 一致）

| 类别 | token / 值 |
|---|---|
| 背景 | `--fb-bg-0:#151517`（页面）、`--fb-bg-1:#232324`（侧边栏/面板）、`--fb-bg-2:#2c2c2e`（卡片）、`--fb-bg-3:#353638`（hover/选中/输入框） |
| 描边 | `--fb-line-1:#ffffff0f`、`--fb-line-2:#ffffff1f`、`--fb-line-3:#ffffff29` |
| 文字 | `--fb-text-1:#f9fafb`、`--fb-text-2:#cfd3d6`、`--fb-text-3:#adb2b8`、`--fb-text-4:#81858c` |
| 品牌 | `--fb-brand:#5686fe`、`--fb-brand-hi:#7aaaff`、`--fb-brand-deep:#4176e6`、`--fb-brand-dim:#5686fe24`、`--fb-grad:linear-gradient(135deg,#5686fe,#7aaaff)`（logo/新对话按钮/发送钮/头像/tab 指示条） |
| 语义 | `--fb-up:#f25a5a`（涨，CN 语义）、`--fb-up-dim:#f25a5a1f`、`--fb-down:#22c55e`（跌）、`--fb-down-dim:#22c55e1f`、`--fb-warn:#f59e0b`、`--fb-skeleton:#ffffff14`、`--fb-hover:#ffffff14` |
| 圆角 | 8 / 12（卡片）/ 16（面板、气泡）/ 999（pill） |
| 阴影 | `--fb-shadow-1/2`、`--fb-glow:0 0 0 1px #5686fe4d,0 4px 24px #5686fe26`（输入框 focus） |
| 字体 | `--fb-font-ui`（-apple-system…PingFang SC）、`--fb-font-brand:"Montserrat"`（字标）、`--fb-font-mono`（数字/代码）；字号阶梯 11/12/13/14/16/18/20/24；`.fb-num{font-variant-numeric:tabular-nums}` |

keyframes（纯 CSS）：`fb-blink`（流式光标）、`fb-breathe`（连接点/空态 logo）、`fb-dot`（思考三点）、`fb-shimmer`（骨架屏）、`fb-fade-up`（入场）、`fb-spin`（spinner）、`fb-pulse`。

样式迁移：`format.ts` 的 `C` 各值改 `var(--fb-*, dsw色值)` 带 fallback（旧 client bundle `src/client/index.tsx` 不加载 terminal.css，fallback 保证官方 SPA 侧栏里的旧面板同一套色值）；`up/down/warn` 保留 hex。组件全 className 化，内联只留动态值。

## 四、前端结构（`src/terminal/`）

```
app.tsx            根布局：Sidebar + 视图切换(home/chat/board/fund) + 顶行连接pill + auth 横幅
sidebar.tsx        新：logo/新对话/会话列表(sessions store)/底部导航
home/HomeView.tsx  新：问候+提问框+建议chips+指数行+新闻列表（数据 fetchBriefing）
fund/FundView.tsx  新：基金下钻（头部/持仓KPI/净值走势+区间切换/预测信号/RBSA篮子/相关新闻/追问dock）
chat/ChatPanel.tsx 由 ChatDrawer 重构：去抽屉化，主区 760 居中；头部 ⇱ 官方轨迹深链
chat/MessageList.tsx 气泡体系/渐变头像/流式光标/思考三点/ToolCard 状态条+spinner
board 视图 = <TerminalPanel onFundClick={code => setView({kind:'fund',code})} />（下钻入口新增一个 prop）
```

组件映射改动量：
- **新增**：`sidebar.tsx`、`home/HomeView.tsx`（含 IndexCard/NewsCard 子组件）。
- **重构**：`app.tsx`（布局骨架重写）、`ChatDrawer.tsx → chat/ChatPanel.tsx`（容器去抽屉化 + 全宽居中，会话逻辑不变）。
- **纯视觉**：`MessageList.tsx`、`TerminalPanel.tsx`、四个 tab、`charts.tsx`（渐变面积图）、`QuickOpModal.tsx`。
- **不动**：`dsh/*`、`api.ts` 现有函数（只加 fetchBriefing）、轮询/job/审批逻辑。

## 五、实施顺序（每阶段 `pnpm build` 核对）

1. **基础设施**：新增 `terminal.css`；`app.tsx` 加 import；`index.html` 加 link + 防闪烁色 `#151517`；`src/index.ts` 加 `/terminal/app.css` 路由；`format.ts` token 化。→ 检查点：全站换 dsw 色板。
2. **应用骨架**：`sidebar.tsx` + `app.tsx` 四视图切换 + `ChatDrawer→ChatPanel` 重构（chat 主区居中）+ board 挂载 TerminalPanel。→ 检查点：视图可切换，会话可选可聊。
3. **AI 首页**：`HomeView` + `GET /finance/api/briefing` + `fetchBriefing` + 建议/新闻/指数点击转 prompt（无活动会话先建）。简报 404 时的降级态（「让 daimon 生成今日简报」按钮 → jobs API）。
4. **基金下钻**：`FundView`（snapshot/holdings 前端过滤出单基金数据）+ TerminalPanel 加 `onFundClick` 入口 + 追问 dock（基金上下文 prompt 注入）+ RBSA 篮子空态。
5. **每日简报生成**：`JOB_ACTIONS.daily_briefing` + finance skill `briefing()`（指数行情直出 + 新闻候选），心跳/日报 agent 负责筛选解读落盘；dsh-home 运行手册补一节。
6. **视觉精修**：看板各 tab（KPI 大数字、FundCard 徽章/chip、渐变面积图、表格类）、QuickOpModal、MessageList/ToolCard/composer 精修、骨架屏、stagger 入场。

## 六、验证

1. `pnpm build`：`lib/terminal/` 产出 `app.js + app.css + index.html`。
2. `pnpm test` + `pnpm typecheck`；`tests/terminal-routes.spec.ts` 加 `app.css` 路由断言；`node scripts/e2e-protocol.mjs` 无回归。
3. 重启 dsh 后 chrome-devtools MCP 打开 `http://127.0.0.1:3180/?token=...`（token 需用户从启动终端复制），与 01.pen 逐屏比对：
   - 默认落地 = AI 首页：问候、提问框 focus 发光、指数行数字、新闻卡影响徽章/关联基金 chip
   - 点新闻/建议/指数卡 → 自动建/切会话并发出对应 prompt
   - 看板页点基金卡 → 基金下钻：返回可用、区间切换、追问 dock 发送的 prompt 携带基金上下文、RBSA 未就绪时显示空态按钮
   - 侧边栏会话列表选中高亮、新对话可用、底部「官方界面」开 `/index.html`
   - 看板页完整（KPI/基金卡/四 tab），简报 404 降级按钮可触发 `daily_briefing` job
   - `/terminal/app.css` 200，控制台无报错
4. 触发一次 `POST /finance/api/jobs {action:'daily_briefing'}` 验证 briefing.json 生成与首页刷新（5 秒轮询）。

## 风险

- 新闻源：finance skill 目前只有热点主题热力，没有新闻流——`briefing()` 的新闻候选需要接一个资讯源（可用 agent 的 web 能力在心跳任务里补齐，skill 先出指数与候选槽位）。这是本计划最大的不确定点，阶段 4 先落地结构，新闻源后补。
- SVG attribute 不支持 `var()` → 图表 hex 常量单点维护于 format.ts。
- dsh 升级时 token 值需人工再对齐（抄自 0.1.7-rc.2，与钉版一致）。
- 涨跌语义保持中式（红涨绿跌），仅借 dsw 色值不借语义。
