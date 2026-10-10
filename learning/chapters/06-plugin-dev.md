# 第 6 章 · 插件开发实战

> 预计用时：3 小时 ｜ 前置：第 1、4 章
> 本章目标：**学完你能写出学习中心那样的完整插件**（host API + client UI 双面包）

## 🎯 学习目标

1. 从 `--profile X` 到插件激活，完整走一遍启动链路。
2. 掌握 patch 合并语义的全部细节（id 寻址 / insert / 整体替换 / 未匹配只 warn）。
3. 说清 `!!js` 的两个求值时机，不再踩坑。
4. 理解 preset 机制：loader 树管进程，agentPresets 管 Agent 作用域。
5. 照模板写出一个 host + client 双面插件并接入 profile。

---

## 💡 6.0 导入：你已经维护过一个插件组合了

回看我们这个 `daimon-web` profile——你其实已经做过插件开发的大部分动作：裁功能块（disabled）、挂新插件（insert）、改端口（config 覆盖）、踩过 inject 报错、踩过 `ctx.config` 不存在的坑。本章把这些经验全部对号到源码机制上，然后给你一套可直接抄的最小模板。

---

## 📖 6.1 Profile / Bundle / Patch 的真实定义

**Profile 就是一个目录**（`$DSH_HOME/profiles/<name>/`），只有三件东西：

- `package.json` —— `dsh.profile.bundles` 声明有序 bundle 列表
- `cordis.patch.yml` —— 用户自己的 patch 层
- `pnpm-workspace.yaml` —— 让树外插件共享安装内单份 cordis

关键设计：`cordis.yml` **每次启动被重写为空数组**（[profile-boot.ts:171](</Users/bytedance/codes/open-source/deepseek-harness/apps/cli/src/profile-boot.ts:171>)）——整棵树完全由 patch 层合成，防止 loader 写回把合成结果烤进根文件。

**Bundle 就是声明了 `dsh.bundle.patch` 的 npm 包**（package-manifest/src/types.ts:69-78）。官方模板钉死常用组合（profile.ts:179-195）：`web = [dsh-base, dsh-web-app]`、`headless = [dsh-base, dsh-headless]`……bundle 解析「安装优先」——官方 bundle 永远来自 dsh 安装本身（调试自己 fork 的 dsh-base 不会生效！）。

**Patch 层合成顺序**（[profile-context.ts:63-75](</Users/bytedance/codes/open-source/deepseek-harness/packages/boot/app-boot/src/profile-context.ts:63>)）：

```text
bundle 层（按 bundles 顺序）→ profile 用户层 → $DSH_HOME/cordis.patch.yml → --patch overlay → telemetry 开关
```

越后越赢。home 层刻意高于 profile 层（机器级偏好全局生效）。

---

## 📖 6.2 applyEntryPatches：30 行读懂全部合并语义

整个体系的合并语义**只有一个实现**（[vendor/include/src/index.ts:57-127](</Users/bytedance/codes/open-source/deepseek-harness/vendor/include/src/index.ts:57>)），挂载和 `--dump-config` 共用——**看到的 = 启动的**：

```ts
for (const patch of patches) {
  const { id, insert, name, ...overrides } = patch
  if (insert) {
    if (id) { /* 目标是 group 则插进其 config 列表 */ }
    else { data.push(...insert) }          // 无 id 插根列表末尾
    buildMap(insert)                          // 插入的行当层即可被后续 patch 寻址
    continue
  }
  if (!id) { warn('patch: id is required'); continue }
  const target = entryMap.get(id)
  if (!target) { warn('patch: entry %C not found', id); continue }   // ← 只 warn 不报错！
  if (name && name !== target.name) { warn(...); continue }          // name 防呆
  for (const [key, value] of Object.entries(overrides)) target[key] = value  // ← 整键覆盖
}
```

四条铁律：

| # | 规则 | 后果/坑 |
|---|---|---|
| 1 | id 匹配不到**只告警跳过**，不报错 | 拼错 id 静默无效——**改完必 `--dump-config` 验证** |
| 2 | insert 的行**当层即可**被后续 patch 寻址 | bundle 插入的行，用户层同次启动就能 patch 它 |
| 3 | config 是**整体替换**，不做深合并 | 想调 preset 里一个键，要把该行完整重述（daimon-web 用户层几百行就是这么来的） |
| 4 | disabled 沿祖先链级联；group 自身永不禁用 | 裁功能块只要禁祖先 group |

---

## 📖 6.3 `!!js`：两个求值时机（高频坑）

`!!js` 表达式用 `with(ctx) { eval(expr) }` 求值（loader/config/utils.ts:5-9），但**两种字段的上下文不同**：

| 字段 | 求值上下文 | 能访问 | 典型用法 |
|---|---|---|---|
| `disabled` | **loader 根作用域** | `ctx.get(...)`、`process` | `!!js process.platform === 'win32'`；`!!js "!ctx.get('profileContext')"` |
| `config` 内的 | **插件自己的 ctx**，inject 就绪后惰性插值 | 插件注入的服务、`dshHomePath(...)` | 配置里引用服务实例 |

> ⚠️ 在 `disabled` 里引用插件级服务得到 `undefined`；在 Group/Include/AgentPreset 这些**树载体**的 config 里写表达式不会当场求值——嵌套行的表达式属于各行自己的 fiber。

---

## 📖 6.4 Agent preset：第二棵树

preset **不是 loader 层概念**，而是普通插件 `dsh-agent-preset`（[preset/agent-preset/src/index.ts:12-30](</Users/bytedance/codes/open-source/deepseek-harness/packages/preset/agent-preset/src/index.ts:12>)）：

```ts
export default class AgentPreset {
  static inject = ['agentPresets']        // 等注册表服务
  async* [Service.init]() {
    yield await this.ctx.agentPresets.register(this.config)   // 启动即把 YAML 定义注册进注册表
  }
}
```

- web-app bundle 用四个 patch 文件各 insert 一行 preset 声明（standard / ptc / minimal / cordis）
- `AgentPresetRegistry` 收到定义后在独立 scope 里 `mountPreset` 激活成**子树**；失败记入 broken 而不拖垮启动
- 默认 preset：`defaultId = selectedDefault.get() ?? config.default`——**切换默认不是删文件、不是 disabled 声明行**，而是改注册表 config
- 二分心智模型：**loader 树管进程，agentPresets 树管 Agent 作用域的能力组合**（工具集/人设）

---

## 📖 6.5 host 插件 vs client 插件

| | host 插件 | client 插件 |
|---|---|---|
| 运行 | Node | 浏览器 |
| 入口 | 包主入口（`exports["."]`） | `exports["./client"]` |
| inject 写的是 | **服务名**（`['webServer']`） | **包名**（映射到 client 服务） |
| 注入面 | 整个 host 服务目录（ctx.sessions / ctx.llm / ctx.webServer…） | `ctx.slots`、`ctx.sidebarRightTabs` 等 |

双面包的两个硬约束：

1. `package.json.dsh.client` 声明加载元数据（platform / inject / external / immediately）
2. **声明了 `dsh.client` 却没有 `./client` 导出 → 组合报错**（client-modules/src/index.ts:847，硬校验）

host 的 client-modules 服务扫描 host 树中所有 `dsh.client` 声明，组合成 `window.__DSH_BOOT__` 入口图——这就是为什么 client 插件不需要你手动往 HTML 里加 script 标签。

**UI 扩展点**：`ctx.slots` 的命名 seat（`sidebar.right.pane.tab`、`conversation.input.activity`…）+ `ctx.sidebarRightTabs` 注册表。学习中心面板的三个 tab 就是这么来的。

---

## 🔗 端到端调用链：`--profile daimon-web` 到 learning-hub 激活（精华 10 跳）

1. `bin.ts:29` `parseDshArgs` → mode: 'profile' → `runProfile`
2. `prepareProfile('daimon-web')`：读 `dsh.profile.bundles`，逐 bundle 解析 patch；**重写 cordis.yml = []**
3. `boot()` → `new Context()` → `ctx.plugin(Loader)` → `mountRootInclude` 建根条目
4. `Include[Service.init]`：读空 cordis.yml → **`applyEntryPatches` 一次合成完整条目树**（learning-hub 的 insert 行在此落位）
5. `EntryGroup.update` 按 id diff，新行 `create()`
6. learning-hub 条目 `_init()`：`import('@local/dsh-learning-hub')` → `registry.plugin(plugin, config)`
7. `inject: ['webServer']` 等待 webServer 就绪 → 激活，`apply` 注册 `/__learning-hub` HTTP API
8. client-modules 扫描到 `dsh.client` 声明 → `./client` 加入 `__DSH_BOOT__` 图
9. 浏览器加载 → `client.js` 的 `apply(ctx)` 注册三个右栏 tab
10. `auditStartupEntries` 审计：required 失败抛 StartupError；可选失败打印 `dsh: warning: N entries did not activate` + pending 清单（**学习中心当初的报错就是在这里打出的**）

---

## 🛠 最小插件模板（host + client，可直接抄）

目录结构：

```text
my-plugin/
├── package.json        # dsh.bundle.patch + dsh.client 双声明
├── cordis.patch.yml    # bundle 层：insert 一行
├── index.js            # host 半
└── client.js           # 浏览器半（无构建，直接 ESM）
```

**package.json**：

```jsonc
{
  "name": "@local/my-plugin",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js", "./client": "./client.js" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true,
                "inject": ["@deepseek-ai/dsh-client-ui-sidebar-right"] }
  }
}
```

**cordis.patch.yml**：

```yaml
- insert:
    - id: my-plugin
      name: '@local/my-plugin'
      config:
        greeting: hello
```

**index.js（host）**：

```js
export const inject = ['webServer']          // 需要的服务，就绪后才激活
export function apply(ctx, config) {         // ← 配置走第二参数，没有 ctx.config！
  ctx.provide('myHello')
  ctx.myHello = { greet: () => `${config.greeting ?? 'hello'} from my-plugin` }
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: '/__my-plugin',
    handler(req, res) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ message: ctx.myHello.greet() }))
    },
  }), 'my-plugin: http')
}
```

**client.js（浏览器）**：

```js
window.__ModuleLoader__.load({
  id: '@local/my-plugin',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const TAB_ID = '@local/my-plugin/hello'
    function HelloBody() { return h('div', { style: { padding: 16 } }, 'Hello from my-plugin') }
    return {
      inject: ['slots', 'sidebarRightTabs'],
      apply(ctx) {
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: TAB_ID, kind: 'my-hello', priority: 'extension', title: () => '你好',
        }), 'my-plugin: tab type')
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab',
          () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, HelloBody)),
          'my-plugin: tab body')
      },
    }
  },
})
```

**接入 profile 两步**：① profile 的 `package.json` dependencies 加 `"@local/my-plugin": "file:/abs/path"` 并把包名追加进 `dsh.profile.bundles`，profile 目录跑一次 `pnpm install`；② 重启。快速实验可先用 `dsh --profile X --patch ./cordis.patch.yml`（overlay 方式零成本），配 `--dump-config` 即时验证。

---

## ⚠️ 常见坑（含调试地图）

1. **拼错 patch id 静默无效** → 改完 `--dump-config` 确认
2. **config 只写差异键** → 整体替换语义会丢掉其余所有键
3. **激活失败去哪看**：stderr 摘要 + `$DSH_HOME/logs/startup-*.log` 完整报告；`inactiveDiagnostic` 会列出 `pending (waiting for services: …)` 清单
4. **config schema 校验失败**抛 ValidationError（含具体 issue 路径）→ 先 `dsh --profile X --dump-config-schema` 查声明
5. **inject 缺失** → fiber 停 pending；修复：确认提供方没被禁用，或给消费方加 `disabled: !!js "!ctx.get('xxx')"` 门控

---

## ✋ 自检问题

1. patch 层五层的顺序？为什么 home 层高于 profile 层？
2. 为什么 `cordis.yml` 每次启动被重写为空？
3. 把默认 preset 从 standard 换成 minimal，正确做法是什么？（不是删文件）
4. host 插件和 client 插件的 `inject` 字段语义有何不同？
5. 声明了 `dsh.client` 但忘了 `./client` 导出会怎样？

## 🛠 练习

- **练习 6.1（跑，20 分钟）**：`pnpm dsh --profile web --dump-config | less`，读合成树（输出带每层来源注释），找出来自 dsh-base、dsh-web-app、用户层各一个条目。
- **练习 6.2（写，60 分钟）**：照 6.6 模板写 `my-plugin` 并接入 daimon-web profile——看到右栏出现「你好」tab + `curl http://127.0.0.1:3180/__my-plugin` 返回 JSON 即成功。
- **练习 6.3（实验，15 分钟）**：用 `--patch` overlay 临时 `disabled: true` 掉一个工具插件，`--dump-config` 验证后启动观察工具消失；再删掉 overlay 恢复。

## 📝 测验

右侧栏「学习测验」→ **第 6 章**（5 题）。

## 📚 延伸阅读

- [docs/subsystems/extensions.zh.md](</Users/bytedance/codes/open-source/deepseek-harness/docs/subsystems/extensions.zh.md>) — 扩展子系统
- [docs/subsystems/boot.zh.md](</Users/bytedance/codes/open-source/deepseek-harness/docs/subsystems/boot.zh.md>) — profile 管理
- [docs/cookbook/extension-cookbook.zh.md](</Users/bytedance/codes/open-source/deepseek-harness/docs/cookbook/extension-cookbook.zh.md>) — 扩展实操手册

---

> ✅ 下一章：**第 7 章 · 综合练习**——用 Harness 改 Harness，把前 6 章全部串起来。
