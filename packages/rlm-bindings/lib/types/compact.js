/**
 * Host handlers for the compact skill's `compact.run` and `compact.status`
 * requests. Compacting mid-cell would abort the run executing the requesting
 * cell, so `compact.run` only records the request and compacts through
 * `ctx.compaction` once the calling agent settles to idle; `compact.status`
 * reads the current request pressure through the token meter and reports
 * whether a compaction is already pending.
 *
 * @module @deepseek-ai/dsh-rlm-bindings/compact
 */
import { ok } from "./read.js";
/**
 * Compact one session each time a pending request survives to an idle phase.
 * The requesting cell was already answered, so a failed attempt is swallowed
 * here; it stays visible in the session log, matching the manual-compaction
 * contract.
 */
async function drainPending(deps, state, key, agent, signal) {
    for (;;) {
        await agent.whenIdle();
        if (!state.pending.delete(key))
            return;
        try {
            await deps.compaction.compactNow(agent, signal);
        }
        catch {
            // Failure is not reportable to the answered cell; the log keeps it.
        }
    }
}
/** Answer `compact.run`: record the request; compaction fires at the next idle phase. */
function runCompact(deps, state, request, context) {
    const instructions = request.data['instructions'];
    if (instructions !== undefined && typeof instructions !== 'string') {
        throw new Error('compact.run instructions must be a string when provided');
    }
    const agent = context.agent;
    if (agent.status !== 'running') {
        return ok({
            scheduled: false,
            reason: 'no active turn; compaction can only be requested while a turn is running',
        });
    }
    const key = String(agent.id);
    state.pending.set(key, instructions);
    if (!state.draining.has(key)) {
        state.draining.add(key);
        const retire = () => {
            state.draining.delete(key);
        };
        // Both branches retire without rethrowing; a rejected drain also drops the
        // pending request so compact.status no longer reports it scheduled.
        void drainPending(deps, state, key, agent, context.signal).then(retire, () => {
            state.pending.delete(key);
            retire();
        });
    }
    return ok({
        scheduled: true,
        note: 'Compaction runs when the current turn ends; the summary replaces older history. Continue working normally.',
    });
}
/** Read the current pressure, or null when the meter cannot measure. */
function measureTokens(deps, session) {
    try {
        return deps.usage.measure(session).totalTokens;
    }
    catch {
        return null;
    }
}
/** Resolve the usable context window of the calling agent's route, or null when unknown. */
async function resolveContextWindow(deps, agent, signal) {
    const provider = agent.options.provider;
    const model = agent.options.model;
    if (provider === undefined || model === undefined)
        return null;
    try {
        const info = await deps.models.resolveModelInfo(provider, model, signal);
        const window = info.context?.contextWindow;
        return window !== undefined && window > 0 ? window : null;
    }
    catch {
        return null;
    }
}
/** Answer `compact.status` with the reference host's field shape. */
async function runCompactStatus(deps, state, context) {
    const tokens = measureTokens(deps, context.agent.session);
    const contextWindow = await resolveContextWindow(deps, context.agent, context.signal);
    const percent = tokens !== null && contextWindow !== null ? (tokens / contextWindow) * 100 : null;
    return ok({
        tokens,
        context_window: contextWindow,
        percent,
        scheduled: state.pending.has(String(context.agent.id)),
    });
}
/**
 * Assemble the two host handlers the compact skill answers.
 *
 * @param deps - the composition services captured at load.
 * @returns the handler map to register on `ctx.rlmKernel`.
 */
export function createCompactHostHandlers(deps) {
    const state = { pending: new Map(), draining: new Set() };
    return {
        'compact.run': (request, context) => Promise.resolve(runCompact(deps, state, request, context)),
        'compact.status': (_request, context) => runCompactStatus(deps, state, context),
    };
}
//# sourceMappingURL=compact.js.map