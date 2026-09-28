/**
 * The nine host handlers answering the RLM Python runtime's `host_request`
 * types. Spawn-style requests drive `ctx.subagents`' continuable manager,
 * roster requests fold each child's session cut through `ctx.sessionQuery`,
 * model search reads `ctx.llm`, and background-command completions steer a
 * notice into the owning session. Handler errors become error replies, so
 * every validation message is model-facing text.
 *
 * @module @deepseek-ai/dsh-rlm-bindings/subagents
 */
import { randomUUID } from 'node:crypto';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createBashCompletionMessage } from "./bash.js";
import { foldChildFacts, rlmActivityStaleMs } from "./child-facts.js";
import { findRlmModels } from "./models.js";
import { bashCompletionField, bashConsumedField, collectTargetsField, collectTimeoutField, createDefaultChildName, deleteTargetField, findModelsRequest, kwargsField, normalizeRequestedModel, normalizeRequestedName, normalizeRequestedThinking, ok, progressNoteMessage, rlmChildLabel, splitModelSelector, stringField, } from "./read.js";
/** Hard cap for labels carried into roster rows. */
const RLM_REGISTRY_LABEL_MAX_LENGTH = 200;
/** Interval between observation rounds while `rlm.collect` waits. */
const COLLECT_POLL_INTERVAL_MS = 100;
/** Resolve the route a spawn runs on: the requested selector, or the parent's. */
function resolveRoute(requested, agent, operation) {
    if (requested !== undefined) {
        const route = splitModelSelector(requested, operation);
        return { selector: requested, provider: route.provider, model: route.model };
    }
    const provider = agent.options.provider;
    const model = agent.options.model;
    if (provider === undefined || model === undefined) {
        throw new Error(`${operation}: no model was given and the parent session has no provider/model route to inherit`);
    }
    return { selector: `${provider}/${model}` };
}
/** Read one child's session cut and fold its facts, disposing the lease. */
async function observeFacts(deps, childId, signal) {
    const observation = await deps.observations.observeSession(SessionId(childId), { signal, projectionMode: 'all' });
    try {
        return foldChildFacts(observation.events, observation.projections?.values.subagentTiming);
    }
    finally {
        observation[Symbol.dispose]();
    }
}
/** Snapshot every direct child of the calling parent, catalog order. */
async function snapshotChildren(deps, agent, signal) {
    const parent = String(agent.id);
    const catalog = await deps.subagents.listChildren(agent.id, signal);
    const snapshots = [];
    for (const child of catalog) {
        const childId = String(child.id);
        const facts = await observeFacts(deps, childId, signal);
        const entry = deps.roster.entry(parent, childId);
        const name = entry?.name ?? child.label ?? createDefaultChildName('', childId);
        if (facts.running && facts.lastActivityAt !== undefined) {
            deps.roster.observeActivity(childId, facts.lastActivityAt, performance.now());
        }
        const progressNote = deps.roster.progressNote(childId);
        const activityStaleMs = rlmActivityStaleMs(facts.running, facts.lastActivityAt, deps.roster.activityMonotonicAt(childId));
        snapshots.push({
            childId,
            name,
            sessionDir: deps.sessionDir(childId),
            label: (entry?.label ?? name).slice(0, RLM_REGISTRY_LABEL_MAX_LENGTH),
            ...progressNote === undefined ? {} : { progressNote },
            ...activityStaleMs === undefined ? {} : { activityStaleMs },
            facts,
        });
    }
    return snapshots;
}
/** The `rlm.list_subagents` status of one snapshot. */
function rowStatus(facts) {
    if (facts.running)
        return 'running';
    if (facts.lastTurnCompleted === true)
        return 'completed';
    if (facts.lastTurnCompleted === false)
        return 'error';
    return 'running';
}
/** Project one snapshot onto an `rlm.list_subagents` row. */
function toSubagentRow(snapshot) {
    const facts = snapshot.facts;
    return {
        rlm_child_id: snapshot.childId,
        active_session_id: snapshot.childId,
        session_id: snapshot.childId,
        session_name: snapshot.name,
        session_dir: snapshot.sessionDir,
        status: rowStatus(facts),
        ...facts.toolUseCount === undefined ? {} : { tool_use_count: facts.toolUseCount },
        ...facts.durationMs === undefined ? {} : { duration_ms: facts.durationMs },
        ...facts.answerPreview === undefined ? {} : { answer_preview: facts.answerPreview },
        ...facts.repliedSinceTask === undefined ? {} : { replied_since_task: facts.repliedSinceTask },
        ...snapshot.progressNote === undefined ? {} : { progress_note: snapshot.progressNote },
        label: snapshot.label,
        ...facts.lastActivityAt === undefined ? {} : { last_activity_at: facts.lastActivityAt },
        ...snapshot.activityStaleMs === undefined ? {} : { activity_stale_ms: snapshot.activityStaleMs },
    };
}
/** The `rlm.collect` status of one snapshot, with its settled flag. */
function collectStatus(facts) {
    if (facts.running)
        return { status: 'running', settled: false };
    if (facts.lastTurnCompleted === true)
        return { status: 'done', settled: true };
    if (facts.lastTurnCompleted === false)
        return { status: 'error', settled: true };
    return { status: 'queued', settled: false };
}
/** Project one snapshot onto an `rlm.collect` result entry. */
function toCollectRow(snapshot) {
    const facts = snapshot.facts;
    const { status, settled } = collectStatus(facts);
    return {
        rlm_child_id: snapshot.childId,
        session_name: snapshot.name,
        session_dir: snapshot.sessionDir,
        status,
        settled,
        ...facts.answerPreview === undefined ? {} : { answer_preview: facts.answerPreview },
        ...facts.error === undefined ? {} : { error: facts.error },
        ...facts.durationMs === undefined ? {} : { duration_ms: facts.durationMs },
        ...facts.toolUseCount === undefined ? {} : { tool_use_count: facts.toolUseCount },
        ...facts.repliedSinceTask === undefined ? {} : { replied_since_task: facts.repliedSinceTask },
    };
}
/** Select the one snapshot a delete target names, with the subagent error vocabulary. */
function selectOneSnapshot(snapshots, target) {
    const matches = snapshots.filter(snapshot => snapshot.childId === target || snapshot.name === target);
    const [first, second] = matches;
    if (first === undefined) {
        throw new Error(`No direct RLM subagent matches "${target}" in the current parent session`);
    }
    if (second !== undefined) {
        throw new Error(`RLM subagent selector "${target}" is ambiguous in the current parent session`);
    }
    return first;
}
/** Select the snapshots a target list names, or every one for an empty list. */
function selectSnapshots(snapshots, targets) {
    if (targets.length === 0)
        return [...snapshots];
    const selected = [];
    for (const target of targets) {
        const [first, second] = snapshots.filter(snapshot => snapshot.childId === target || snapshot.name === target);
        if (first === undefined) {
            throw new Error(`No direct RLM child matches "${target}" in the current parent session`);
        }
        if (second !== undefined) {
            throw new Error(`RLM child selector "${target}" is ambiguous in the current parent session`);
        }
        selected.push(first);
    }
    return selected;
}
/** Sleep one collect poll round. */
function delay(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}
/** Shared spawn path behind `rlm.run` and `rlm.create_session`. */
async function runSpawn(deps, request, context, operation) {
    const prompt = stringField(request.data, 'prompt', `${operation} prompt must be a string`);
    const kwargs = kwargsField(request.data);
    let name = normalizeRequestedName(kwargs['name'], operation);
    const requestedModel = normalizeRequestedModel(kwargs['model'], operation);
    const thinking = normalizeRequestedThinking(kwargs['thinking'], operation);
    let mintedId;
    if (operation === 'rlm.create_session') {
        if (kwargs['cwd'] !== undefined) {
            throw new Error('rlm.create_session: the cwd kwarg is not supported by this host');
        }
        mintedId = SessionId(randomUUID());
        name ??= createDefaultChildName(prompt, String(mintedId));
    }
    if (name === undefined)
        throw new Error('rlm.spawn name is required');
    const route = resolveRoute(requestedModel, context.agent, operation);
    const agentOptions = {
        ...route.provider === undefined ? {} : { provider: route.provider },
        ...route.model === undefined ? {} : { model: route.model },
        ...thinking === undefined ? {} : { reasoningEffort: ReasoningEffortId(thinking) },
    };
    const parent = String(context.agent.id);
    const release = deps.roster.reserve(parent, name, operation);
    let start;
    try {
        start = await deps.subagents.startContinuable({
            provider: deps.providerName,
            label: name,
            ...mintedId === undefined ? {} : { childId: mintedId },
            request: {
                prompt: [{ type: 'text', text: prompt }],
                parent: context.agent,
                ...Object.keys(agentOptions).length === 0 ? {} : { agentOptions },
            },
            signal: context.signal,
        });
    }
    catch (error) {
        release();
        throw error;
    }
    const childId = String(start.childId);
    deps.roster.admit(parent, {
        childId,
        name,
        model: route.selector,
        label: rlmChildLabel(prompt),
        createdAt: Date.now(),
    });
    if (operation === 'rlm.create_session') {
        return ok({
            active_session_id: childId,
            session_id: childId,
            name,
            session_file: deps.sessionDir(childId),
            model: route.selector,
        });
    }
    return ok({
        rlm_child_id: childId,
        name,
        session_dir: deps.sessionDir(childId),
        model: route.selector,
    });
}
/** Answer `rlm.collect`: a bounded wait over selected children, never a timeout error. */
async function runCollect(deps, request, context) {
    const targets = collectTargetsField(request.data);
    const timeoutMs = collectTimeoutField(request.data);
    const selected = selectSnapshots(await snapshotChildren(deps, context.agent, context.signal), targets);
    if (timeoutMs > 0) {
        const deadline = Date.now() + timeoutMs;
        while (!context.signal.aborted) {
            const pending = selected.filter(snapshot => !collectStatus(snapshot.facts).settled);
            if (pending.length === 0)
                break;
            const remaining = deadline - Date.now();
            if (remaining <= 0)
                break;
            await delay(Math.min(COLLECT_POLL_INTERVAL_MS, remaining));
            for (const snapshot of pending) {
                snapshot.facts = await observeFacts(deps, snapshot.childId, context.signal);
            }
        }
    }
    return ok({ results: selected.map(toCollectRow) });
}
/** Answer `rlm.delete_subagent`: drain one settled child, skip a running one. */
async function runDelete(deps, request, context) {
    const target = deleteTargetField(request.data);
    const snapshot = selectOneSnapshot(await snapshotChildren(deps, context.agent, context.signal), target);
    const row = toSubagentRow(snapshot);
    if (row.status === 'running') {
        return ok({ subagent: row, outcome: 'skipped_running' });
    }
    await deps.subagents.drainContinuableChildren(context.agent, [SessionId(row.rlm_child_id)]);
    deps.roster.forget(String(context.agent.id), row.rlm_child_id);
    return ok({ subagent: row });
}
/**
 * Assemble the nine host handlers the bindings answer.
 *
 * @param deps - the composition services captured at load.
 * @returns the handler map to register on `ctx.rlmKernel`.
 */
export function createRlmHostHandlers(deps) {
    return {
        'rlm.run': (request, context) => runSpawn(deps, request, context, 'rlm.spawn'),
        'rlm.create_session': (request, context) => runSpawn(deps, request, context, 'rlm.create_session'),
        'rlm.find_models': async (request) => {
            const { query, limit } = findModelsRequest(request.data);
            return ok({ models: await findRlmModels(deps.models, query, limit) });
        },
        'rlm.list_subagents': async (_request, context) => {
            const snapshots = await snapshotChildren(deps, context.agent, context.signal);
            return ok({ subagents: snapshots.map(toSubagentRow) });
        },
        'rlm.collect': (request, context) => runCollect(deps, request, context),
        'rlm.progress.note': (request, context) => {
            const message = progressNoteMessage(request.data);
            const result = deps.roster.noteProgress(String(context.agent.id), message, Date.now());
            if (result === undefined) {
                throw new Error('rlm.progress.note: this session is not a registered RLM child');
            }
            return Promise.resolve(ok(result.accepted
                ? { accepted: true }
                : { accepted: false, retry_after_ms: result.retryAfterMs }));
        },
        'rlm.delete_subagent': (request, context) => runDelete(deps, request, context),
        'bash.completed': (request, context) => {
            const details = bashCompletionField(request.data);
            const message = createBashCompletionMessage(details);
            context.agent.steer(message);
            deps.notices.record(String(context.agent.id), details.pid, details.command, message.id);
            return Promise.resolve(ok({}));
        },
        'bash.consumed': (request, context) => {
            const details = bashConsumedField(request.data);
            const messageId = deps.notices.takeEarliest(String(context.agent.id), details.pid, details.command);
            if (messageId !== undefined)
                context.agent.inbox.remove(messageId);
            return Promise.resolve(ok({}));
        },
    };
}
//# sourceMappingURL=subagents.js.map