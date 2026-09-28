/**
 * Read-only family observation behind the agent-observe skill. The calling
 * session's nuclear family — its direct parent, its siblings, and its direct
 * children — is derived from the durable session header plus the subagent
 * catalogs; every family member is then read through one immutable session
 * cut from `ctx.sessionQuery`. Observation never mutates a session, and a
 * target outside the nuclear family is refused with the shared reach error.
 *
 * @module @deepseek-ai/dsh-rlm-bindings/observe
 */
import { SessionId } from '@deepseek-ai/dsh-session';
import { foldChildFacts } from "./child-facts.js";
import { ok, stringField } from "./read.js";
/** Shared cap for the message previews carried by roster rows. */
export const AGENT_OBSERVE_PREVIEW_MAX_CHARS = 240;
/** Default number of recent messages one `agent_observe.recent` call returns. */
export const DEFAULT_OBSERVE_LIMIT = 8;
/** Default per-message preview size of one `agent_observe.recent` call. */
export const DEFAULT_OBSERVE_MAX_CHARS = 800;
/** Refusal every out-of-family observation target receives. */
export const AGENT_FAMILY_REACH_ERROR = 'Agent reach is limited to parent, siblings, and children';
/**
 * Join the text of one message's content blocks, one line per block.
 *
 * @param content - the content blocks of one persisted message.
 * @returns the joined human-readable text; non-text blocks become placeholders.
 */
export function contentText(content) {
    return content
        .map((block) => {
        switch (block.type) {
            case 'text': return block.text;
            case 'reasoning': return block.text;
            case 'image': return '[image]';
            case 'file': return '[file]';
            case 'tool-call': return `[tool_call:${block.name}]`;
            default: return '';
        }
    })
        .filter(line => line.length > 0)
        .join('\n');
}
/**
 * Fold one session event cut into its conversation messages, in log order.
 *
 * @param events - the session log's events at the observation cut.
 * @returns the folded conversation messages, indexed in log order.
 */
export function foldMessageEvents(events) {
    const messages = [];
    for (const event of events) {
        if (event.type === 'user/message') {
            messages.push(foldMessage(event.time, event.data, messages.length));
        }
        else if (event.type === 'developer/message') {
            messages.push(foldMessage(event.time, event.data.message, messages.length));
        }
        else if (event.type === 'system/message') {
            messages.push(foldMessage(event.time, event.data.message, messages.length));
        }
        else if (event.type === 'assistant/message') {
            messages.push(foldMessage(event.time, event.data.message, messages.length));
        }
        else if (event.type === 'tool/result') {
            messages.push(foldMessage(event.time, event.data.message, messages.length));
        }
    }
    return messages;
}
/** Fold one carried message into its preview source row. */
function foldMessage(time, message, index) {
    const toolCalls = message.role === 'assistant'
        ? message.content.filter(block => block.type === 'tool-call').map(block => block.name)
        : undefined;
    return {
        index,
        role: message.role,
        timestamp: time,
        text: contentText(message.content),
        ...toolCalls !== undefined && toolCalls.length > 0 ? { toolCalls } : {},
    };
}
/**
 * Clip one folded message to a bounded preview.
 *
 * @param message - the folded conversation message.
 * @param maxChars - the preview size cap, in UTF-16 code units.
 * @returns the wire preview, with `truncated` marking any clip.
 */
export function createMessagePreview(message, maxChars) {
    const clipped = message.text.length > maxChars;
    return {
        index: message.index,
        role: message.role,
        timestamp: message.timestamp,
        text: clipped ? message.text.slice(0, maxChars) : message.text,
        truncated: clipped,
        ...message.toolCalls === undefined ? {} : { toolCalls: [...message.toolCalls] },
    };
}
/** Validate an optional integer payload member. */
function optionalInteger(value, label) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new Error(`${label} must be an integer when provided`);
    }
    return value;
}
/** Clamp one bounded integer argument. */
function clampInteger(value, min, max, label) {
    if (value < min || value > max) {
        throw new Error(`${label} must be between ${min} and ${max}`);
    }
    return value;
}
/**
 * Normalize the `limit` argument of one `agent_observe.recent` call.
 *
 * @param limit - the raw requested limit, when provided.
 * @returns the bounded limit.
 */
export function normalizeObserveLimit(limit) {
    return clampInteger(limit ?? DEFAULT_OBSERVE_LIMIT, 1, 50, 'agent_observe limit');
}
/**
 * Normalize the `max_chars` argument of one `agent_observe.recent` call.
 *
 * @param maxChars - the raw requested preview size, when provided.
 * @returns the bounded preview size.
 */
export function normalizeObserveMaxChars(maxChars) {
    return clampInteger(maxChars ?? DEFAULT_OBSERVE_MAX_CHARS, 80, 2_000, 'agent_observe max_chars');
}
/**
 * Derive the calling session's nuclear family from its durable header and
 * the subagent catalogs. A subagent child's siblings are its parent's other
 * catalog children; a top-level session's siblings are the other live roots,
 * matching the roots-are-siblings reach rule. Deeper ancestors and their
 * descendants stay unreachable: communication with them relays through the
 * intermediate family member.
 *
 * @param source - the composition services the catalog is derived from.
 * @param agent - the calling session's agent.
 * @param signal - cancellation while reading the catalogs.
 * @returns the family snapshot: own display name plus reachable members.
 */
export async function listFamilyMembers(source, agent, signal) {
    const currentId = String(agent.id);
    const parentId = agent.session.header.parentSession;
    const byName = (left, right) => left.name.localeCompare(right.name);
    const members = [];
    let selfName = currentId;
    if (parentId !== undefined) {
        const pid = String(parentId);
        members.push({ relationship: 'parent', id: pid, name: pid, ...liveMember(source, parentId) });
        const siblings = [];
        for (const entry of await source.subagents.listChildren(parentId, signal)) {
            const id = String(entry.id);
            const name = source.roster.entry(pid, id)?.name ?? entry.label ?? id;
            if (id === currentId) {
                selfName = name;
                continue;
            }
            siblings.push({ relationship: 'sibling', id, name, ...liveMember(source, entry.id) });
        }
        siblings.sort(byName);
        members.push(...siblings);
    }
    else {
        const roots = [];
        for (const root of source.agents.roots()) {
            if (root.id === agent.id)
                continue;
            roots.push({ relationship: 'sibling', id: String(root.id), name: String(root.id), agent: root });
        }
        roots.sort(byName);
        members.push(...roots);
    }
    const children = [];
    for (const entry of await source.subagents.listChildren(agent.id, signal)) {
        const id = String(entry.id);
        const name = source.roster.entry(currentId, id)?.name ?? entry.label ?? id;
        children.push({ relationship: 'child', id, name, ...liveMember(source, entry.id) });
    }
    children.sort(byName);
    members.push(...children);
    return { selfName, members };
}
/** Spread the live-agent field of one family member, when resident. */
function liveMember(source, id) {
    const agent = source.agents.get(id);
    return agent === undefined ? {} : { agent };
}
/** Project one matched candidate onto its observation target. */
function toObserveTarget(candidate) {
    return candidate.kind === 'current'
        ? { id: candidate.id, options: { current: true, name: candidate.name } }
        : { id: candidate.member.id, options: { relationship: candidate.member.relationship, name: candidate.member.name } };
}
/**
 * Resolve one `agent_observe.get` / `agent_observe.recent` target selector
 * against the calling session and its reachable family, by exact id or name
 * first and by unambiguous suffix second.
 *
 * @param deps - the composition services.
 * @param agent - the calling session's agent.
 * @param target - the raw target selector.
 * @param signal - cancellation while reading the catalogs.
 * @returns the resolved target.
 */
async function resolveObserveTarget(deps, agent, target, signal) {
    const family = await listFamilyMembers(deps, agent, signal);
    const candidates = [
        { kind: 'current', id: String(agent.id), name: family.selfName },
        ...family.members.map(member => ({ kind: 'member', member, id: member.id, name: member.name })),
    ];
    const exact = candidates.filter(candidate => candidate.id === target || candidate.name === target);
    const matches = exact.length > 0
        ? exact
        : candidates.filter(candidate => candidate.id.endsWith(target) || candidate.name.endsWith(target));
    const [first, second] = matches;
    if (first === undefined)
        throw new Error(AGENT_FAMILY_REACH_ERROR);
    if (second !== undefined)
        throw new Error(`agent_observe target ${JSON.stringify(target)} is ambiguous`);
    return toObserveTarget(first);
}
/**
 * The coarse runtime classification of one session, from its durable header.
 *
 * @param header - the session's durable identity metadata.
 * @returns `subagent` for a delegated child, `top-level` otherwise.
 */
export function headerRuntimeKind(header) {
    return (header.delegationDepth ?? 0) > 0 || header.origin === 'subagent' ? 'subagent' : 'top-level';
}
/** Project one session cut plus live-registry facts onto a wire summary. */
function summarizeCut(deps, cut, id, options) {
    const facts = foldChildFacts(cut.events, cut.projections?.values.subagentTiming);
    const messages = foldMessageEvents(cut.events);
    const live = deps.agents.get(SessionId(id));
    const header = cut.header;
    const running = facts.running;
    const firstUser = messages.find(message => message.role === 'user');
    const latest = messages.at(-1);
    return {
        ...live === undefined ? {} : { activeSessionId: id },
        sessionId: id,
        sessionName: options.name,
        ...options.relationship === undefined ? {} : { relationship: options.relationship },
        runtimeKind: headerRuntimeKind(header),
        ...header.cwd === undefined ? {} : { cwd: header.cwd },
        status: running ? 'model' : live === undefined ? 'inactive' : 'idle',
        isCurrent: options.current === true,
        isStreaming: live !== undefined && running,
        isCompacting: false,
        attachedClients: 0,
        messageCount: messages.length,
        queuedCount: live === undefined ? 0 : live.inbox.nextTurn.length + live.inbox.nextStep.length,
        isSessionActive: live !== undefined,
        ...facts.repliedSinceTask === undefined ? {} : { repliedSinceTask: facts.repliedSinceTask },
        ...header.parentSession === undefined ? {} : { parentSessionId: String(header.parentSession) },
        ...firstUser === undefined ? {} : { firstMessage: firstUser.text.slice(0, AGENT_OBSERVE_PREVIEW_MAX_CHARS) },
        ...latest === undefined ? {} : { latestMessage: createMessagePreview(latest, AGENT_OBSERVE_PREVIEW_MAX_CHARS) },
    };
}
/** Observe one session and project its wire summary, disposing the lease. */
async function summarizeSession(deps, id, options, signal) {
    const cut = await deps.observations.observeSession(SessionId(id), { signal, projectionMode: 'all' });
    try {
        return summarizeCut(deps, cut, id, options);
    }
    finally {
        cut[Symbol.dispose]();
    }
}
/** Answer `agent_observe.list`: the calling session plus its whole family. */
async function runList(deps, context) {
    const family = await listFamilyMembers(deps, context.agent, context.signal);
    const agents = [];
    for (const member of family.members) {
        agents.push(await summarizeSession(deps, member.id, { relationship: member.relationship, name: member.name }, context.signal));
    }
    return ok({
        current: await summarizeSession(deps, String(context.agent.id), { current: true, name: family.selfName }, context.signal),
        agents,
    });
}
/** Answer `agent_observe.get`: one reachable session's summary. */
async function runGet(deps, data, context) {
    const target = stringField(data, 'target', 'agent_observe.get target must be a string');
    const resolved = await resolveObserveTarget(deps, context.agent, target, context.signal);
    return ok({ agent: await summarizeSession(deps, resolved.id, resolved.options, context.signal) });
}
/** Answer `agent_observe.recent`: bounded recent message previews of one reachable session. */
async function runRecent(deps, data, context) {
    const target = stringField(data, 'target', 'agent_observe.recent target must be a string');
    const limit = normalizeObserveLimit(optionalInteger(data['limit'], 'agent_observe.recent limit'));
    const maxChars = normalizeObserveMaxChars(optionalInteger(data['max_chars'] ?? data['maxChars'], 'agent_observe.recent max_chars'));
    const resolved = await resolveObserveTarget(deps, context.agent, target, context.signal);
    const cut = await deps.observations.observeSession(SessionId(resolved.id), { signal: context.signal, projectionMode: 'all' });
    try {
        const messages = foldMessageEvents(cut.events);
        const startIndex = Math.max(0, messages.length - limit);
        return ok({
            agent: summarizeCut(deps, cut, resolved.id, resolved.options),
            messages: messages.slice(startIndex).map(message => createMessagePreview(message, maxChars)),
            limit,
            maxChars,
            truncated: startIndex > 0,
        });
    }
    finally {
        cut[Symbol.dispose]();
    }
}
/**
 * Assemble the three observation handlers the agent-observe skill calls.
 *
 * @param deps - the composition services captured at load.
 * @returns the handler map to register on `ctx.rlmKernel`.
 */
export function createAgentObserveHostHandlers(deps) {
    return {
        'agent_observe.list': (_request, context) => runList(deps, context),
        'agent_observe.get': (request, context) => runGet(deps, request.data, context),
        'agent_observe.recent': (request, context) => runRecent(deps, request.data, context),
    };
}
//# sourceMappingURL=observe.js.map