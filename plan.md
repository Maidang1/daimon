自建金融优先 Web UI 计划（替代官方 SPA，dsh 只做运行时）                                                                                                                  │
   │                                                                                                                                                                           │
   │ 目标与已确认的方向                                                                                                                                                        │
   │                                                                                                                                                                           │
   │ 浏览器体验整体换成自建的金融终端：http://127.0.0.1:3180/ 打开即我们的 UI（不再是上游 DeepSeek SPA），布局为全屏 Finance 终端（复用现有四个 tab + 快捷操作）+ 右侧聊天抽屉 │
   │ （会话列表/对话流/输入，v1 核心够用：文本流式 + 工具调用可折叠卡片 + 审批/用户提问应答）。dsh 完全不动：会话、模型路由、python 工具、REPL、finance skill 全部照旧，我们只 │
   │ 复刻它的浏览器传输层。                                                                                                                                                    │
   │                                                                                                                                                                           │
   │ 已验证的关键事实（探查自 dsh 0.1.7-rc.2 产物）：                                                                                                                          │
   │                                                                                                                                                                           │
   │ • 接管 / 可行：webserver exact 路由优先于上游 SPA 占的 fallback seat。token 交换委托给 ctx.connection.authorizeIndex(req, res)（inject connection 服务）：带 ?token= 的   │
   │   GET / → 它发 cookie + 303；之后带 cookie 的 GET / → 返回 true，我们 serve 自己的 index.html；无凭证 → 它回 401，我们什么都不用做。                                      │
   │ • 官方 SPA 留后门零成本：接管 / 后 GET /index.html 仍走 fallback 静态服务（同样的 authorizeIndex 门），官方界面随时可回。                                                 │
   │ • API 传输层只有两个面：                                                                                                                                                  │
   │     • unary：POST /api/<ns>/<m>，body {"type":"client-request","rpcId","method","payload":{"args":{...}}}，响应                                                           │
   │       {"type":"server-response","rpcId,"result":{"ok":true,"value"|"ok":false,"error"}}；                                                                                 │
   │     • stream：WebSocket /api/remote.mux，帧 {type:"open",streamId,endpoint,payload} / item / end / error，单条 WS 多路复用所有流；内置 $events endpoint（waterfall 事件必 │
   │       须回 POST /api/$events/result，否则卡住 agent）。                                                                                                                   │
   │     • 同源部署 cookie 自动携带，无 CORS 问题（服务端有 Host/Origin 回环栅栏，正好）。                                                                                     │
   │ • 会话端点：unary session/create|list|prompt|cancel；stream session/follow（首帧 snapshot {records,hasMore,...}，随后持久事件 {type,event:{type,seq,time,data}} +         │
   │   assistantStream:true 时的 {type:"assistant-stream",frame:{type:"start|chunk|end"}} 增量）。事件类型清单在 dsh-api-session-controller/lib/types/types.d.ts 与            │
   │   dsh-session 的 SessionEventMap，实现时按 curated 子集渲染。                                                                                                             │
   │ • 无 client-loader 约束：自建 UI 是普通静态站点，esbuild 打包、react 打进 bundle，任意依赖可用；现有 src/client 终端组件（tabs/charts/api/format/QuickOpModal）全部复用   │
   │   （esbuild 会把它们的 ./xx.js 导入解析到 .ts/.tsx 源文件）。                                                                                                             │
   │                                                                                                                                                                           │
   │ 改动分块                                                                                                                                                                  │
   │                                                                                                                                                                           │
   │ 1. finance-board host 半：接管 / + serve 自建 UI                                                                                                                          │
   │                                                                                                                                                                           │
   │ packages/finance-board/src/index.ts 扩展（host 半继续兼管 /finance/api/*）：                                                                                              │
   │                                                                                                                                                                           │
   │ • inject 增加 connection（packages/finance-board/cordis.patch.yml 的 insert 行同步加，失败即启动报错，符合本仓库"缺服务大声失败"的约定）。                                │
   │ • GET /（exact）handler：if (!ctx.connection.authorizeIndex(req, res)) return（token 交换/401 已由它响应）；否则返回 lib/terminal/index.html（内存缓存读取，no-cache）。  │
   │ • GET /terminal/app.js（exact）：serve lib/terminal/app.js（esbuild 产物；no-cache 即可，本地服务无需 hash）。                                                            │
   │ • config 增加 terminalDist（默认 <pkg>/lib/terminal，相对 import.meta.url 推导）。                                                                                        │
   │                                                                                                                                                                           │
   │ 2. 自建 SPA：packages/finance-board/src/terminal/                                                                                                                         │
   │                                                                                                                                                                           │
   │ 用 esbuild 打包（新增 devDep esbuild，build 脚本串联进 package build；产物 lib/terminal/）。                                                                              │
   │                                                                                                                                                                           │
   │ • dsh/rpc.ts — unary 客户端：uuid rpcId、envelope 封包、error 映射（{code,message}）、401 时触发全局"凭证失效"横幅（引导重新打开带 token 链接）。                         │
   │ • dsh/mux.ts — WS 多路复用器：连接 /api/remote.mux（协议帧如上），按 streamId 分发 item/end/error，指数退避重连（500ms 起步上限 10s，参考官方 __DSH_CONNECTION_RECOVERY__ │
   │    语义）；同时承载 $events 与 session/follow 两条流。                                                                                                                    │
   │ • dsh/events.ts — $events 订阅：维护连接 clientId；emit 帧记入调试日志（v1 仅 session added/removed 用于刷新会话列表）；waterfall 帧（approval/request、                  │
   │   user-questions/request）转成 UI 回调，用户操作后经 POST /api/$events/result 回执 {clientId,eventId,outcome}（approve / reject / 文本回答）。                            │
   │ • dsh/sessions.ts — 会话 store：session/list 拉列表、session/create 新建（cwd 默认 daimon 仓库）、当前会话 session/follow（WS，assistantStream）→ 快照 records + 增量事件 │
   │   + assistant chunk 合流成消息列表；session/prompt 发送（mode queue）、session/cancel 停止。                                                                              │
   │ • chat/ChatDrawer.tsx — 右侧抽屉（固定宽 420px，可关闭；顶栏按钮/快捷键切换）：会话下拉/列表、消息区、输入框（Enter 发送 / Shift+Enter 换行）、运行中显示停止按钮、审批/  │
   │   提问横幅（同意/拒绝/输入回答）。                                                                                                                                        │
   │ • chat/MessageList.tsx — curated 事件渲染（实现时按 dsh-session 事件 map 对齐）：用户 prompt 气泡、assistant 文本（stream chunk 增量渲染）、工具调用卡片（名称 + 参数摘要 │
   │   + 结果可折叠，python/REPL 输出截断前 N 行）、turn 结束/错误提示。markdown 只做轻量处理（换行/代码块底色），不做高亮。                                                   │
   │ • app.tsx — 根布局：顶栏（「daimon · 金融终端」+ 连接状态点 + 「会话」按钮开抽屉）、主区复用 src/client/TerminalPanel（finance API 同源直连，零改动）、右侧 ChatDrawer。  │
   │ • lib/terminal/index.html — 静态模板（暗色底，防闪烁内联 background），引 /terminal/app.js。                                                                              │
   │                                                                                                                                                                           │
   │ 3. 旧 client bundle 定位调整                                                                                                                                              │
   │                                                                                                                                                                           │
   │ src/client/（dsh client-loader 版面板）保留不动：官方 SPA 后门（/index.html）里它仍提供 Finance 面板；但不再是主入口，selectPanel 默认落地逻辑保留（只影响后门里的体验）  │
   │ 。                                                                                                                                                                        │
   │                                                                                                                                                                           │
   │ 4. 文档同步                                                                                                                                                               │
   │                                                                                                                                                                           │
   │ • 根 README.md：UI 架构改为"自建金融终端（/）+ 官方 SPA 后门（/index.html）"，传输层协议要点，聊天抽屉能力边界（v1 不渲染：图片附件预览、diff、present 富面板、子代理     │
   │   UI——这些仍可从后门进官方 SPA）。                                                                                                                                        │
   │ • dsh-home/AGENTS.md：面板交互一节改为自建终端描述；告知模型用户可能从抽屉发消息、审批请求会以横幅出现。                                                                  │
   │                                                                                                                                                                           │
   │ 5. 测试与验证                                                                                                                                                             │
   │                                                                                                                                                                           │
   │ • 单测（vitest，mock connection/webServer）：                                                                                                                             │
   │     • / 路由三态：authorizeIndex 返回 true → 200 我们的 HTML；false（已 303/401）→ 我们不写响应；                                                                         │
   │     • rpc.ts：envelope 封包/解包、error 映射；                                                                                                                            │
   │     • mux.ts：帧编解码与 streamId 分发（用假 WebSocket）。                                                                                                                │
   │ • 端到端（重启 dsh 后）：                                                                                                                                                 │
   │     • curl / 无 cookie → 401；curl "/?token=..." → 303 + Set-Cookie；带 cookie GET / → 我们的 index.html；                                                                │
   │     • GET /index.html 带 cookie → 官方 SPA 仍在（后门）；                                                                                                                 │
   │     • node 脚本走通真实协议：session/list → session/create → WS session/follow 收到 snapshot → session/prompt 发一条"用 finance.status() 自检" → 收到 assistant-stream    │
   │       chunk 与工具调用事件（验证我们客户端的所有协议假设）；                                                                                                              │
   │     • 浏览器人工确认：默认全屏终端、抽屉聊天、审批横幅（可让 agent 跑一个会触发 ask/approval 的操作）。                                                                   │
   │                                                                                                                                                                           │
   │ 实施顺序                                                                                                                                                                  │
   │                                                                                                                                                                           │
   │ 1. host 半接管 / + 静态 serve（含 package patch inject）→ 2. rpc/mux/events 传输层 + 单测 → 3. 会话 store + 聊天抽屉 UI → 4. 根布局拼装（复用 TerminalPanel）→ 5. 文档 →  │
   │    6. 端到端验证。                                                                                                                                                        │
   │                                                                                                                                                                           │
   │ 风险与备注                                                                                                                                                                │
   │                                                                                                                                                                           │
   │ • 事件协议细节：SessionEventMap 的具体事件名/数据形状以 dsh-session 类型为准，实现第 3 步时先读类型再写渲染；协议假设用端到端 node 脚本实测兜底。                         │
   │ • waterfall 必答：审批/提问漏回会卡死 agent——events.ts 对未知 waterfall 类型默认回 next（放行），已知类型才打扰用户。                                                     │
   │ • 版本耦合：传输层协议绑定 dsh 0.1.7-rc.2；升级 dsh 需回归本 UI（README 记录此约束）。                                                                                    │
   │ • 旧 client bundle 与新 SPA 并存，finance-board 一个包两个构建目标，build 脚本保持串联，失败即停。
