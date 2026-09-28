/**
 * Host bindings answering the RLM Python runtime's `host_request` types: child
 * spawning and fan-in through `ctx.subagents`, model search through `ctx.llm`,
 * session goals through `ctx.goals`, deferred compaction through
 * `ctx.compaction` and `ctx.tokenMeter`, family messaging and observation
 * through `ctx.agents`, continual-harness refinement scheduling, and internal
 * heartbeats persisted under the DSH home. The handlers mount on
 * `ctx.rlmKernel` once per composition and read the calling agent off each
 * request's context, so one registration serves every session's kernel.
 *
 * @module @deepseek-ai/dsh-rlm-bindings
 */
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { SessionId } from '@deepseek-ai/dsh-session';
import { BashNoticeBoard } from "./bash.js";
import { createCompactHostHandlers } from "./compact.js";
import { createGoalHostHandlers } from "./goal.js";
import { HeartbeatScheduler, HeartbeatStore, createHeartbeatHostHandlers } from "./heartbeat.js";
import { createMcpHostHandlers, readMcpServersFile } from "./mcp.js";
import { createAgentMessageHostHandlers } from "./message.js";
import { createModelInfoHostHandlers } from "./model-info.js";
import { createAgentObserveHostHandlers } from "./observe.js";
import { RefineRequests, createRefineHostHandlers, createRefineTurnStopping } from "./refine.js";
import { Roster } from "./roster.js";
import { createRlmHostHandlers } from "./subagents.js";
export const name = 'rlm-bindings';
export const inject = ['rlmKernel', 'subagents', 'llm', 'sessionQuery', 'agents', 'goals', 'tokenMeter'];
/** Validated plugin configuration for the RLM host bindings. */
export const Config = z.object({
    providerName: z.string().default('spawn'),
    dshHome: z.string().default(''),
    mcpServersFile: z.string().default(''),
});
/**
 * Register the host-request handlers on the kernel service.
 *
 * The roster the handlers share lives for the composition's lifetime; the
 * registration itself is withdrawn when the plugin's fiber disposes. The
 * heartbeat table persists under the DSH home, so a restart resumes the
 * stored beats; refinement requests stay process-local and die with it.
 *
 * @param ctx - the Cordis context this plugin registers into.
 * @param config - validated configuration with the spawn provider name.
 */
export function apply(ctx, config = {}) {
    const providerName = config.providerName ?? 'spawn';
    const dshHome = config.dshHome === undefined || config.dshHome.trim().length === 0 ? undefined : config.dshHome;
    const observations = ctx.sessionQuery;
    // Compaction is not a host-plane service in every composition: the shipped
    // Web composition keeps the engine inside each agent's isolated preset
    // mount, so the backend resolves it from the calling agent at request time
    // instead of injecting it here — plainly from the agent's scope when the
    // mount is unisolated, and through the preset registry's serviceFor when
    // the mount sits behind an isolate realm.
    const scopedCompaction = {
        compactNow: (agent, signal) => {
            const live = ctx.agents.get(agent.session.header.id);
            if (live === undefined) {
                return Promise.reject(new Error('the calling agent is not live in this host'));
            }
            const engine = live.ctx.get('compaction') ?? ctx.get('agentPresets')?.serviceFor(live, 'compaction');
            if (engine === undefined) {
                return Promise.reject(new Error('no compaction engine is mounted in the calling agent\'s scope'));
            }
            return engine.compactNow(agent, signal);
        },
    };
    const roster = new Roster();
    const requests = new RefineRequests();
    const scheduler = new HeartbeatScheduler({
        store: new HeartbeatStore(join(resolveDshHome(dshHome), 'rlm', 'heartbeats.json')),
        resolveAgent: id => ctx.agents.get(SessionId(id)) ?? undefined,
        onError: (error) => {
            ctx.logger('rlm-bindings').warn('heartbeat delivery failed: %s', error);
        },
    });
    scheduler.start();
    const withdraw = ctx.rlmKernel.registerHostRequestHandlers({
        ...createRlmHostHandlers({
            subagents: ctx.subagents,
            models: ctx.llm,
            observations,
            roster,
            providerName,
            sessionDir: (childId) => join(resolveDshHome(dshHome), 'rlm', 'children', childId),
            notices: new BashNoticeBoard(),
        }),
        ...createGoalHostHandlers({ goals: ctx.goals }),
        ...createCompactHostHandlers({ compaction: scopedCompaction, usage: ctx.tokenMeter, models: ctx.llm }),
        ...createModelInfoHostHandlers({ models: ctx.llm }),
        ...createMcpHostHandlers({
            servers: () => readMcpServersFile(config.mcpServersFile === undefined || config.mcpServersFile.trim().length === 0
                ? join(resolveDshHome(dshHome), 'mcp-servers.json')
                : config.mcpServersFile),
        }),
        ...createAgentMessageHostHandlers({ agents: ctx.agents, subagents: ctx.subagents, roster }),
        ...createAgentObserveHostHandlers({ agents: ctx.agents, subagents: ctx.subagents, roster, observations }),
        ...createHeartbeatHostHandlers({ heartbeats: scheduler }),
        ...createRefineHostHandlers({ requests }),
    });
    ctx.on('agent/turn-stopping', createRefineTurnStopping({ requests }));
    ctx.on('agent/disposed', ({ agent }) => {
        requests.forget(String(agent.id));
        scheduler.cancelSession(String(agent.id));
    });
    ctx.effect(() => () => {
        scheduler.dispose();
        withdraw();
    });
}
//# sourceMappingURL=index.js.map