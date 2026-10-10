# 第 1 章 · 一切皆插件 + Cordis 基础

> 预计用时：3 小时（本课程最难的一章，值得）｜ 前置：第 0 章
> 源码主战场：`$REPO/vendor/cordis/src/`（上游 cordis 4.0.0-rc.7 的 fork，TS 源码可读）

## 🎯 学习目标

1. 解释 Cordis 的核心抽象：**fiber 树 + 被 Proxy 包裹的 Context**。
2. 说清「属性访问即服务解析」：`ctx.llm` 这行代码背后发生了什么。
3. 写出插件的三种形态，描述 fiber 生命周期与「可逆副作用」。
4. 区分五种事件分发模式，背出 waterfall 的 9 行实现。
5. 读懂 loader 的装配语义：patch / insert / group / isolate / disabled。

---

## 💡 1.0 导入：昨天的报错是最好的一课

还记得学习中心插件启动失败的那行吗？

```
learning-hub (@local/dsh-learning-hub): Error: cannot get property "config" without inject
```

当时我们「修好了」它——但你是真的会了吗？回答三个问题：

- 为什么访问 `ctx.config` 会**报错**，而不是返回 `undefined`？（JS 对象读不存在的属性明明是 undefined）
- 错误信息里的 "without inject" 是什么意思？
- 为什么改成 `apply(ctx, config)` 第二参数就对了？

学完本章，这三个问题会变成送分题。它们触及了 Cordis 最反直觉也最关键的设计：**`ctx` 不是普通对象，而是一个 Proxy**。

---

## 📖 1.1 Context：一个从诞生起就是 Proxy 的对象

根 Context 的构造器（[vendor/cordis/src/context.ts:74](</Users/bytedance/codes/open-source/deepseek-harness/vendor/cordis/src/context.ts:74>)）：

```ts
const self = new Proxy<this>(this, ReflectService.handler)
this.root = self
this.fiber = new Fiber(self, {}, Object.create(null), null, () => [])
this.reflect = new ReflectService(self)
this.registry = new RegistryService(self)
this.events = new EventsService(self)
this.logger = new LoggerService(self)
...
return self   // ← JS 构造器返回对象会覆盖 this：根 context 从诞生起就是代理
```

于是每一次 `ctx.foo` 都会穿过 proxy 的 `get` trap（[reflect.ts:135](</Users/bytedance/codes/open-source/deepseek-harness/vendor/cordis/src/reflect.ts:135>)），按四级顺序解析：

```text
① isSpecialProperty?（symbol / then / 数字 / _ 开头）→ 直接透传
② Reflect.has(target, prop)?（原型上的真实方法，如 ctx.extend）→ 包一层 traceable 返回
③ reflect.props[prop] 是 accessor?（mixin 转发的计算属性）→ 走自定义 getter
   —— ctx.on、ctx.plugin 就是这样从 events/registry 服务转发出来的
④ 兜底：沿 fiber 链向上爬，找第一个提供了该服务的 fiber
```

第 ④ 级就是「服务解析」（[reflect.ts:153-166](</Users/bytedance/codes/open-source/deepseek-harness/vendor/cordis/src/reflect.ts:153>)）：

```ts
let fiber = (ctx[symbols.shadow] ?? ctx).fiber
while (true) {
  const impl = fiber.store?.[prop]
  if (impl) return getTraceable(ctx, impl.value)   // 命中：返回服务实现
  if (prop in fiber.inject) {                      // 声明了 inject 但还没就绪
    error.message = `cannot get required service "${prop}" in inactive context`
    throw error
  }
  if (!fiber.runtime) throw error                   // 爬到根仍没找到 → 默认报错
  if (fiber.parent[symbols.isolate][prop] !== key) throw error  // 跨出隔离边界
  fiber = fiber.parent.fiber
}
```

> 💡 **回到导入的报错**：`ctx.config` 从未被任何插件 `provide`，四级全落空、爬到根 → 抛 `cannot get property "config" without inject`（错误对象在 [reflect.ts:144](</Users/bytedance/codes/open-source/deepseek-harness/vendor/cordis/src/reflect.ts:144>) 构造）。所以它不是 undefined，是**主动抛错**——这是故意的：把「依赖写错了」从静默 bug 变成响亮报错。

---

## 📖 1.2 provide / inject / epoch：依赖追踪闭环

**注册一个服务**（[reflect.ts:277-305](</Users/bytedance/codes/open-source/deepseek-harness/vendor/cordis/src/reflect.ts:277>)）：

```ts
provide(name: string, value?: any, check?: () => boolean) {
  return this.ctx.fiber.effect(() => {          // ① 注册本身是一个 effect（卸载自动反注册）
    this.props[name] = { type: 'service' }      // ② 声明属性类型
    const key = this.ctx[symbols.isolate][name]  // ③ 隔离标签作 key（1.6 节细讲）
    const impl: Impl = { name, value, fiber: this.ctx.fiber, check }
    if (this.store[key]) throw new Error(`service "${name}" has been registered ...`)
    this.store[key] = impl                       // ④ 存进全局 store
    this.ctx.fiber.store![name] = impl           // ⑤ 挂到 fiber 快照供属性查找
    if (this.ctx.fiber.state === FiberState.ACTIVE) this.notify([name])
    return async () => { /* 反注册并唤醒依赖者 */ }
  }, `ctx.provide(...)`)
}
```

**inject 声明**完成闭环的另一半：

1. fiber 构造时对 inject 里每个名字跑 `_checkImpl`（[fiber.ts:597](</Users/bytedance/codes/open-source/deepseek-harness/vendor/cordis/src/fiber.ts:597>)）：找到 ACTIVE 实现才记入快照
2. `_refresh`（[fiber.ts:611](</Users/bytedance/codes/open-source/deepseek-harness/vendor/cordis/src/fiber.ts:611>)）把当前依赖拼成 **epoch 字符串** `:uid1:uid2`
3. 依赖集合变化 → epoch 变化 → `_setEpoch` 触发 `_reload`（重启）或 `_unload`

> 📌 **一句话**：依赖变更 = 换 epoch = 自动重启插件。你不需要手写「等待依赖就绪再启动」的逻辑——声明 inject，Cordis 帮你排序。这就是「加载顺序由依赖声明推导」。

两种 inject 报错要分清（排障时先看是哪种）：

| 报错 | 含义 | 场景 |
|---|---|---|
| `cannot get property "X" without inject` | 沿 fiber 链爬到根都没人 provide X | 属性名写错 / 忘了挂载提供方 |
| `cannot get required service "X" in inactive context` | 声明了 inject，但 fiber 还在 PENDING 等依赖 | 过早的观察者里访问 |

旁路：`ctx.get(name)`（[reflect.ts:233](</Users/bytedance/codes/open-source/deepseek-harness/vendor/cordis/src/reflect.ts:233>)）不受 inject 声明约束，调试工具代码可用。

---

## 📖 1.3 插件三种形态与 fiber 生命周期

**形态**（归一化在 [registry.ts:222](</Users/bytedance/codes/open-source/deepseek-harness/vendor/cordis/src/registry.ts:222>)）：

```ts
// ① 函数
export default function plugin(ctx, config) { ... }
// ② 对象（learning-hub 就是这种）
export function apply(ctx, config) { ... }
// ③ 类（isConstructor 判定：有 prototype 且非箭头/async/generator）
export default class MyService extends Service { ... }
```

执行点（[fiber.ts:250-261](</Users/bytedance/codes/open-source/deepseek-harness/vendor/cordis/src/fiber.ts:250>)）：类用 `new callback(ctx, config)`，函数/apply 直接 `callback(ctx, config)`。**注意配置永远走第二参数——内核没有 `ctx.config`**（全 vendor/cordis/src 无此属性；导入问题的第三个答案）。

**生命周期 = FiberState 状态机**（[fiber.ts:147](</Users/bytedance/codes/open-source/deepseek-harness/vendor/cordis/src/fiber.ts:147>)）：

```text
PENDING → LOADING → ACTIVE → (FAILED) → UNLOADING → DISPOSED
```

三个关键设计：

1. **插件体里返回的函数/生成器/Promise 全被收集为 disposer**——`return () => { cleanup() }` 就是卸载钩子
2. **每个 fiber 是父 fiber 的一个 effect**（[fiber.ts:265](</Users/bytedance/codes/open-source/deepseek-harness/vendor/cordis/src/fiber.ts:265>)）→ 父卸载级联卸载子树，结构化清理
3. **`ctx.on()`、`ctx.provide()` 都是 effect**——fiber 卸载时监听器自动摘除、服务自动反注册

> 📌 「可逆的副作用」是 Cordis 的第一性原理：插件做的一切登记都可撤销，所以 HMR、热更新配置、`disabled: true` 裁剪才能安全实现。

---

## 📖 1.4 事件系统：五种分发模式

| 模式 | 语义 | 用在哪 |
|---|---|---|
| `emit` | 同步调所有监听器，**不 await** 返回值（异步错误静默消失！） | 通知类：`agent/status` |
| `parallel` | `Promise.allSettled` 并发，错误聚合为 `AggregateError` | 需要收集结果的扇出 |
| `serial` | 按序 await，首个 bail 值短路 | 检查点：`agent/turn-stopping` |
| `bail` | serial 的同步版 | `internal/listener` |
| `waterfall` | 环绕中间件：监听器收 `(...args, next)`，**不调 next() 即否决内建行为** | 拦截类：`agent/pre-step`、`approval/request` |

waterfall 全部实现只有 9 行，值得背（[events.ts:234-242](</Users/bytedance/codes/open-source/deepseek-harness/vendor/cordis/src/events.ts:234>)）：

```ts
waterfall(...args: any[]) {
  const cbs = this.dispatch('waterfall', args)
  const inner = args.pop()            // 最后一个参数是内建行为
  const next = () => {
    const cb = cbs.shift() ?? inner   // 监听器耗尽后落到内建行为
    return cb(...args)
  }
  args.push(next)                     // next 作为最后一个参数传给每个监听器
  return next()
}
```

> ⚠️ **忘记 `next()` = 否决**。只想「观察」却忘了委托，会让配置更新等功能神秘失效——这是真实的高发 bug。

`internal/*` 是**内核自身行为的拦截点**（读服务 `internal/get`、配置解析 `internal/config`、配置更新 `internal/update`），与普通业务事件不同：它们由核心服务派发，且不会再触发 `internal/dispatch` 元事件（防无限递归）。

---

## 📖 1.5 Loader：声明式装配

Loader（`@deepseek-ai/cordis-plugin-loader`，vendor/loader）把 YAML 变成插件树。一条 entry 的字段（[entry.ts:10-26](</Users/bytedance/codes/open-source/deepseek-harness/vendor/loader/src/config/entry.ts:10>)）：`id`、`name`、`config`、`group`、`disabled`、`inject`、`isolate`、`intercept`。

| 操作 | 语义 | 锚点 |
|---|---|---|
| **patch** | 按 `id` 定位目标 entry，其余字段整个覆盖 config | include/index.ts:57 |
| **insert** | 追加新条目（有 id 插进该 group 的 config 列表，无 id 插根列表末尾），插入后即可被同层后续 patch 命中 | include/index.ts:79-100 |
| **group** | `group: true` 的 entry 挂 Group 插件，其 config 就是子 entry 列表；祖先 disabled 级联禁用 | group.ts:75 |
| **disabled** | 可以是 `!!js` 表达式（在 loader ctx 上求值，所以能写 `process.platform === 'win32'`）；禁用即 `fiber.dispose()` | entry.ts:89-136 |
| **isolate** | 给子树的服务换隔离标签，实现「同名服务不同实现」 | isolate.ts:96 |

我们的 `daimon-web` profile 就是活教材：`disabled: true` 裁掉 jobs/workflow 整块功能、`insert` 挂 learning-hub、`!!js` 按平台切换 bash/pwsh——你已经在用本章的全部机制了。

---

## 📖 1.6 时空可组合性：论文标题的代码落地

README 里那篇论文的标题，落在两组机制上：

**空间组合**（同一时刻，不同子树看到不同服务）：
- `ctx.isolate(name, label)`：store 的 key 不是服务名而是**隔离标签**（symbol），子树可以有同名服务的另一份实现。传**相同 label** 的两次 isolate 会合并作用域（join scopes）
- `ctx.intercept(name, config)`：给子树追加该服务的配置，自根向叶合并
- 实现手段统一是**原型链**：`extend` 用 `Object.create(this)` 造子 context，图都是影子拷贝

**时间组合**（同一位置，随依赖/配置变化重生）：
- epoch 机制：依赖变化 → 全部 disposer 逆序执行 → 重建，位置不变、状态焕新
- 一切注册可逆 → 任意子树可被整体撤销并重放（HMR 的底座）

---

## 🔗 端到端调用链：`ctx.plugin()` 八跳到激活

1. `ctx.plugin` 属性读取 → proxy get → mixin accessor 转发到 `ctx.registry.plugin`（reflect.ts:221）
2. `RegistryService.plugin`（registry.ts:316）：`resolve()` 归一化形态 → `Inject.resolve` 解析依赖
3. `new Fiber(...)`（registry.ts:330 → fiber.ts:222）：`parent.extend({fiber})` 造子 context → 自身注册为父 fiber 的 effect → `emit('internal/plugin')`（loader 在此挂 entry）
4. `_refresh` 拼 epoch → `_setEpoch` → 状态 LOADING → `_reload()`（fiber.ts:632）
5. `_reload`（fiber.ts:646）：快照依赖 → 让出一个 tick → `internal/config` waterfall + schema 校验配置
6. `_execute` 调插件体：类 `new` / 函数直调（fiber.ts:250）
7. 插件体内 `ctx.provide`/`ctx.on` 全部登记为 effect；`_updateState` → ACTIVE → `notify` 唤醒 PENDING 依赖方（fiber.ts:588）
8. 调用方拿到 awaitable fiber，`await` 它即等启动完成或重抛错误（fiber.ts:704）

---

## ⚠️ 常见坑

1. **两种 inject 报错分不清**：`without inject`（没人提供）vs `in inactive context`（还在等依赖）——排障先分类
2. **改了 vendor/cordis/src 行为没变**：入口是 `lib/index.js`，改源码必须重建（僵尸 lib 的第二章）
3. **`emit` 不 await**：监听器异步错误静默消失；要收集错误用 `parallel`
4. **waterfall 忘调 `next()`**：整条链含内建行为被否决
5. **schema 校验必须同步**：Config 校验器写异步规则直接抛错（fiber.ts:54）

---

## ✋ 自检问题

1. `ctx.on` 既不在 Context 类上定义、也不是服务，为什么能调？（提示：proxy 第 ③ 级，mixin accessor）
2. 插件 A provide 了服务 X，插件 B inject: ['X'] 但启动时 A 还没挂——B 会怎样？A 挂上后呢？
3. 为什么 `disabled: true` 能安全裁掉一个功能块而不留垃圾？（从 effect/disposer 角度答）
4. `emit` 和 `waterfall` 分别适合什么场景？工具审批为什么必须 waterfall？
5. 「没有 `ctx.config`」和「学习中心插件的修复」之间的因果关系是什么？

## 🛠 练习

- **练习 1.1（读，30 分钟）**：按「context.ts 全文（146 行）→ reflect.ts:135-208 + 277-305 → registry.ts 全文」的顺序精读，把 proxy get 四级解析用自己的话画一遍。
- **练习 1.2（跑，45 分钟）**：写 30 行脚本——`new Context()`，provide 一个服务，`ctx.plugin` 两个互相依赖的插件，用 `ctx.on('internal/status')` 打印状态迁移；再 `ctx.isolate('x')` 后在子树 provide 同名服务观察互不影响。（比单读源码理解快得多）
- **练习 1.3（分析，20 分钟）**：打开 `dsh-home/profiles/daimon-web/cordis.patch.yml`，给每个条目标注它用了 1.5 节表格里的哪种操作；找出所有 `!!js` 表达式并说明求值时机。

## 📝 测验

右侧栏「学习测验」→ **第 1 章**（5 题）。

## 📚 延伸阅读

- [docs/cordis-primer.zh.md](</Users/bytedance/codes/open-source/deepseek-harness/docs/cordis-primer.zh.md>) — 官方五概念导读
- [docs/cordis-tutorial/](</Users/bytedance/codes/open-source/deepseek-harness/docs/cordis-tutorial/index.zh.md>) — 动手教程 01-03
- [docs/event-producer-consumer.zh.md](</Users/bytedance/codes/open-source/deepseek-harness/docs/event-producer-consumer.zh.md>) — 事件生产/消费全景图

---

> ✅ 本章是全程最难的一章，啃下来后面一马平川。下一章：**第 2 章 · 核心循环 agent loop**——看这颗「插件化的心脏」如何跳动。
