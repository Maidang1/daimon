import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { RlmHostRequestHandlers } from '@deepseek-ai/dsh-rlm-kernel'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { PythonRlmKernel } from '../src/index.ts'

const PYTHON = process.env.RLM_TEST_PYTHON ?? 'python3'

/** Durable source name carried by every agent-message receipt. */
const AGENT_MESSAGE_SOURCE = 'agent_message'

/** Absolute directory of the bundled `py/skills/` tree this package ships. */
function skillsSourceDir(): string {
  return fileURLToPath(new URL('../py/skills/', import.meta.url))
}

function agent(id: string): Agent {
  return { id: brandString<SessionId>(id) } as Agent
}

function okReply(result: JsonValue): { readonly status: 'ok'; readonly result: JsonValue } {
  return { status: 'ok', result }
}

async function kernel(): Promise<PythonRlmKernel> {
  const ctx = new Context()
  await ctx.plugin(PythonRlmKernel, { pythonBin: PYTHON, pythonPath: [skillsSourceDir()] })
  return ctx.get('rlmKernel') as PythonRlmKernel
}

describe('bundled RLM skill packages', () => {
  it('imports all seven skill packages from py/skills over pythonPath', async () => {
    const service = await kernel()
    const handle = await service.acquire(agent('skills-import'))
    const cell = await handle.execute(
      'import goal, compact, refine, rlm_heartbeat, agent_message, agent_observe, finance\n'
      + 'print(goal.__name__, compact.__name__, refine.__name__, '
      + 'rlm_heartbeat.__name__, agent_message.__name__, agent_observe.__name__, finance.__name__)',
    )
    expect(cell.status).toBe('ok')
    expect(cell.stdout).toContain('goal compact refine rlm_heartbeat agent_message agent_observe finance')
    await service.release('skills-import' as SessionId)
  })

  it('finance owns its state under FINANCE_HOME: ops/holdings closed loop + board render', async () => {
    const service = await kernel()
    const handle = await service.acquire(agent('skills-finance-board'))
    const cell = await handle.execute(`
import os, tempfile
os.environ['FINANCE_HOME'] = tempfile.mkdtemp()
import finance

s = await finance.status()
assert s['finance_home'] == os.environ['FINANCE_HOME']

# 建仓（artifact 未生成时宽容渲染：持仓/操作立即可见，基金网格为空）
h = await finance.set_holding('008401', 1000, 2000.0, name='测试基金')
assert h['status'] == 'success' and 'dashboard' in h

# 注册基金进预测流水线（RBSA 篮子）
rf = await finance.register_fund('008401', {'标普500等权': {'market': 'US', 'tickers': ['YF:RSP']}})
assert rf['status'] == 'success'
try:
    await finance.register_fund('008401', {'x': {'market': 'US', 'tickers': ['YF:QQQ']}})
    raise SystemExit('duplicate register_fund not rejected')
except ValueError:
    pass

# 看板操作记录：买入 + 卖出超额 warning（不落盘）
r = await finance.add_op('008401', 'buy', 100, 1.2345, date='2026-09-29', note='t')
assert r['status'] == 'success' and 'dashboard' in r
w = await finance.add_op('008401', 'sell', 99999, 1.5)
assert 'warning' in w
assert len((await finance.ops())['ops']) == 1

# 校验拦截
for bad in [('99999x', 'buy', 1, 1.0), ('008401', 'hold', 1, 1.0), ('008401', 'buy', -1, 1.0)]:
    try:
        await finance.add_op(*bad)
        raise SystemExit(f'no error for {bad}')
    except finance.FinanceError:
        pass

# 写入假 artifact 后渲染看板：ops 烘焙进 HTML、无 localStorage、</ 转义
from finance import _state
_state.write_json(_state.state_path('artifact_latest.json'), {
    'jobKind': 'test', 'jobLabel': '测试', 'updatedAt': '2026-09-29 14:00',
    'summary': 's</script>', 'notes': '', 'track': [], 'corrections': [],
    'funds': [{'code': '008401', 'name': '测试基金', 'officialNav': 1.2,
               'officialDate': '2026-09-28', 'officialRet': 0.5}],
})
r2 = await finance.add_op('008401', 'sell', 50, 1.3, note='卖一半')
assert 'dashboard' in r2
html = open(r2['dashboard'], encoding='utf-8').read()
assert 'localStorage' not in html and '卖一半' in html and '<\\\\/script>' in html

# 持仓重算（镜像看板 computePos）：1000 基线 + 100 买 - 50 卖
pos = (await finance.holdings())['positions']['008401']
assert abs(pos['shares'] - 1050) < 1e-6, pos
d = await finance.delete_op(1)
assert d['ops_count'] == 1
print('finance-closed-loop OK', len(html))
`)
    expect(cell.status).toBe('ok')
    expect(cell.stdout).toContain('finance-closed-loop OK')
    await service.release('skills-finance-board' as SessionId)
  })

  it('finance analysis engine submodules import as a package', async () => {
    const service = await kernel()
    const handle = await service.acquire(agent('skills-finance-imports'))
    const cell = await handle.execute(`
import os, tempfile
os.environ['FINANCE_HOME'] = tempfile.mkdtemp()
import finance
# 纯 stdlib 子模块（licaitong/rbsa/hotspot/jobs 需 miniconda 的 requests/pandas，由真实 kernel 覆盖）
for m in ('portfolio', 'industry', 'agent', 'dashboard'):
    finance._mod(m)
print('submodules OK')
`)
    expect(cell.status).toBe('ok')
    expect(cell.stdout).toContain('submodules OK')
    await service.release('skills-finance-imports' as SessionId)
  })

  it('runs each skill\'s client-side validation without any host handler', async () => {
    const service = await kernel()
    const handle = await service.acquire(agent('skills-validation'))
    const cell = await handle.execute(`
import goal, compact, refine, rlm_heartbeat, agent_message, agent_observe

async def check():
    results = []
    for thunk, ename in [
        (lambda: goal.create(1), 'TypeError'),
        (lambda: compact.run(1), 'TypeError'),
        (lambda: compact.run('focus on the migration'), 'ValueError'),
        (lambda: refine.run(global_='x'), 'TypeError'),
        (lambda: rlm_heartbeat.create(1), 'TypeError'),
        (lambda: rlm_heartbeat.create('x', delivery_mode='bad'), 'ValueError'),
        (lambda: agent_observe.get_agent(1), 'TypeError'),
        (lambda: agent_observe.recent_messages('t', limit='x'), 'TypeError'),
        (lambda: agent_message.send('hi'), 'ValueError'),
        (lambda: agent_message.send('hi', receiver_role='parent', receiver_name='n'), 'ValueError'),
    ]:
        try:
            await thunk()
        except Exception as err:
            results.append(type(err).__name__)
        else:
            results.append('no-error')
    return results

print(await check())
`)
    expect(cell.status).toBe('ok')
    expect(cell.stdout).toContain(
      "['TypeError', 'TypeError', 'ValueError', 'TypeError', 'TypeError', 'ValueError', 'TypeError', 'TypeError', 'ValueError', 'ValueError']",
    )
    await service.release('skills-validation' as SessionId)
  })

  it('round-trips goal.get and rlm_heartbeat.list through stub host handlers', async () => {
    const seen: string[] = []
    const hostRequests: RlmHostRequestHandlers = {
      'goal.get': () => {
        seen.push('goal.get')
        return Promise.resolve(okReply({ goal: null, remaining_tokens: null, completion_budget_report: null }))
      },
      'rlm_heartbeat.list': (request) => {
        seen.push(`rlm_heartbeat.list:${JSON.stringify(request.data['include_inactive'])}`)
        return Promise.resolve(okReply({ heartbeats: [] }))
      },
    }
    const service = await kernel()
    const handle = await service.acquire(agent('skills-wire'), { hostRequests })
    const cell = await handle.execute(`
import goal, rlm_heartbeat
g = await goal.get()
h = await rlm_heartbeat.list(include_inactive=True)
print(sorted(g), g['goal'])
print(h['heartbeats'])
`)
    expect(cell.status).toBe('ok')
    expect(cell.stdout).toContain("['completion_budget_report', 'goal', 'remaining_tokens'] None")
    expect(cell.stdout).toContain('[]')
    expect(seen).toEqual(['goal.get', 'rlm_heartbeat.list:true'])
    await service.release('skills-wire' as SessionId)
  })

  it('sends an agent_message through a stub host and emits the receipt display', async () => {
    const hostRequests: RlmHostRequestHandlers = {
      'agent_message.send': request =>
        Promise.resolve(okReply({
          id: 'agentmsg_stub',
          source: AGENT_MESSAGE_SOURCE,
          deliveryStatus: 'delivered',
          receiverRole: request.data['receiver_role'] ?? null,
        })),
    }
    const service = await kernel()
    const handle = await service.acquire(agent('skills-message'), { hostRequests })
    const displays: unknown[] = []
    const cell = await handle.execute(
      `import agent_message
receipt = await agent_message.send('hello parent', receiver_role='parent')
print(receipt['deliveryStatus'])`,
      { onEvent: (event) => { if (event.event === 'display') displays.push(event.data) } },
    )
    expect(cell.status).toBe('ok')
    expect(cell.stdout).toContain('delivered')
    expect(displays).toHaveLength(1)
    const data = displays[0] as Record<string, unknown>
    expect(data['text/plain']).toBe('Agent message sent')
    const mime = data['application/vnd.prime-agent.agent-message+json'] as Record<string, unknown>
    expect(mime['deliveryStatus']).toBe('delivered')
    await service.release('skills-message' as SessionId)
  })

  it('surfaces the host error for a wire with no registered handler', async () => {
    const service = await kernel()
    const handle = await service.acquire(agent('skills-unhandled'))
    const cell = await handle.execute(`
import compact
try:
    await compact.status()
except RuntimeError as err:
    print(type(err).__name__, str(err)[:60])
`)
    expect(cell.status).toBe('ok')
    expect(cell.stdout).toContain('RuntimeError')
    await service.release('skills-unhandled' as SessionId)
  })
})
