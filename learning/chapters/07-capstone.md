# 第 7 章 · 综合练习：用 Harness 改自己（毕业设计）

> 预计用时：3–6 小时 ｜ 前置：第 0–6 章全部
> 本章没有新知识点——只有你、源码，和前六章的全部武器。

## 🎯 毕业标准

完成一个**跨层功能**，达到可提交 PR 的质量：

1. 触及至少两层（host 插件 + client UI / 工具 + 审批 / 会话事件 + 投影……）
2. 每个改动点都能说出「为什么扩展点在这里」（对照 architecture.zh.md:142 的「新行为的归属位置」表）
3. 有测试或可执行的验证步骤、有 README、遵循仓库 commit 规范
4. 通过导师（daimon）按 PR review 标准的验收

---

## 💡 7.1 选题（三选一，或自拟）

### 选题 A：学习中心阶段 4 —— 自适应难度（推荐）

给 `@local/dsh-learning-hub` 加「按 quiz 成绩推荐下一章难度」：

- **host 半**：新增 `/__learning-hub/api/recommendation` 路由，读 quiz-log.jsonl 计算各章正确率（第 6 章的 webServer 扩展）
- **client 半**：进度面板顶部加「推荐」卡片（第 5 章的 slot 注册）
- **投影思维**：正确率不要存成新文件——从 quiz-log 派生（第 3 章「日志即事实源」）
- **验证**：故意答错两题，看推荐是否变化

**它串联**：ch01（inject/effect）、ch03（派生 vs 存储）、ch05（client/Host 边界）、ch06（双面包结构）

### 选题 B：自定义工具 + 审批策略

写一个 `say` 工具（打印一条消息到会话）+ 一条 pre-execute 策略（工作时间外要求审批）：

- `defineTool` 三层校验 + render 纯投影（第 4 章）
- `tools/pre-execute` waterfall 监听器按时间返回 allow/ask（第 1、4 章）
- 挂进 daimon-web profile 用 `--dump-config` 验证（第 6 章）
- **验证**：让 agent 调用该工具，观察审批弹窗；改系统时间（或 mock）观察策略变化

**它串联**：ch01（waterfall）、ch04（管线五段）、ch06（patch 接入）

### 选题 C：会话统计投影 + 右栏面板

写一个「会话统计」插件：实时显示当前会话的 turn 数、工具调用数、压缩次数：

- 注册一个 projection 单元（init/apply/stateVersion，第 3 章）
- host 半暴露查询 API 或直接走 client model
- client 半注册右栏 tab 展示（第 5、6 章）
- **验证**：边聊天边看数字跳动；重启后会话恢复，数字正确重放

**它串联**：ch02（事件词汇）、ch03（投影铁律）、ch05（UI 注册）

---

## 📖 7.2 开发流程（按顺序做，别跳步）

```text
① 画分层图：你的功能触及哪几层？每层的扩展点事件/服务是什么？
   —— 先查 architecture.zh.md:142「新行为的归属位置」表，选对 seam
② --patch overlay 零成本实验：先挂空插件验证装配，再填实现
③ host 半先行：curl 验证 API，再接 client
④ client 半最小化：先 renderSlot 出现，再加交互
⑤ 对抗性验证：kill -9 重启（事件重放对不对？）、换 preset（inject 缺失怎么退化？）
⑥ --dump-config + startup 日志终审
```

## 📖 7.3 PR review 验收清单（导师会逐项过）

- [ ] **扩展点选择正确**：没有用 monkey-patch / 改 vendor 源码实现本应走 seam 的功能
- [ ] **fail-closed 姿态**：inject 的服务缺失时行为是退化而非崩溃（第 4 章原则）
- [ ] **不落盘的瞬态 vs 持久事件**分清了（没有监听 assistant-stream 做持久化）
- [ ] **配置走 schema 校验**（schemastery），非法配置报 ValidationError 而非运行时炸
- [ ] **disposer 完整**：插件 disabled 后不留 HTTP 路由、监听器等垃圾
- [ ] **重放安全**：写 presenter/projection 时不抛异常、不依赖进程内状态
- [ ] **commit 规范**：`type(scope): 中文描述`，一个 commit 一件事

---

## ✋ 自检问题（答辩用）

1. 你的功能触及哪几层？每层的扩展点是什么？如果换成用别的事件实现，会有什么语义差异？
2. 如果上游 API 变了（比如某事件 payload 加字段），你的改动会如何失败——响亮地报错还是静默出错？为什么？
3. 你的功能在 `headless` profile（无 webserver、无浏览器）下应该怎么退化？
4. 哪部分状态是「事实」、哪部分是「投影」？如果让你支持 fork 会话，哪里要改？
5. 讲一个开发中踩的坑，以及它在源码里的根因（文件:行号）。

## 🛠 练习

- **练习 7.1（毕业设计）**：完成选题并提交完整变更到 daimon 仓库（或 deepseek-harness fork），然后对导师说「review 我的毕业设计」。导师会按 7.3 清单逐项过，并提出至少一个修改意见——改完才算毕业。

## 📝 测验

右侧栏「学习测验」→ **第 7 章**（综合题，覆盖全部章节）。

## 📚 毕业后去哪

- [docs/cookbook/extension-cookbook.zh.md](</Users/bytedance/codes/open-source/deepseek-harness/docs/cookbook/extension-cookbook.zh.md>) — 更多扩展食谱
- [CONTRIBUTING.zh.md](</Users/bytedance/codes/open-source/deepseek-harness/CONTRIBUTING.zh.md>) — 给上游提 PR 的规范
- `docs/subsystems/` 其余 60+ 篇 —— 挑你用的子系统精读
- 给插件仓库加 `dsh-plugin` topic，让社区发现你的作品

---

> 🎓 通过 review 后，在「学习中心」勾选本章——8/8 进度条拉满。你用 Harness 学会了 Harness，并用 Harness 改了 Harness。这就是这门课的全部意义。
