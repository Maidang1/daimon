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
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session';
import type { SubagentCatalogEntry, SubagentTimingProjection } from '@deepseek-ai/dsh-subagent';
import type { RlmHostRequestHandlers } from '@deepseek-ai/dsh-rlm-kernel';
import type { Roster } from './roster.ts';
/** Shared cap for the message previews carried by roster rows. */
export declare const AGENT_OBSERVE_PREVIEW_MAX_CHARS = 240;
/** Default number of recent messages one `agent_observe.recent` call returns. */
export declare const DEFAULT_OBSERVE_LIMIT = 8;
/** Default per-message preview size of one `agent_observe.recent` call. */
export declare const DEFAULT_OBSERVE_MAX_CHARS = 800;
/** Refusal every out-of-family observation target receives. */
export declare const AGENT_FAMILY_REACH_ERROR = "Agent reach is limited to parent, siblings, and children";
/** Sender or receiver position inside the nuclear family. */
export type AgentFamilyRelationship = 'parent' | 'sibling' | 'child';
/** The slice of `ctx.agents` family listing and delivery read through. */
export interface LiveAgentSource {
    /** The exact live agent of one durable session id, when resident. */
    get(id: SessionId): Agent | undefined;
    /** All live top-level agents, in registration order. */
    roots(): Agent[];
}
/** The slice of `ctx.subagents` the family catalog reads through. */
export interface ChildCatalogSource {
    /** The current direct-child catalog of one parent session. */
    listChildren(parent: SessionId, signal?: AbortSignal): Promise<SubagentCatalogEntry[]>;
}
/** The composition services the nuclear-family catalog is derived from. */
export interface FamilySource {
    /** The live-agent registry. */
    readonly agents: LiveAgentSource;
    /** The direct-child catalog reader. */
    readonly subagents: ChildCatalogSource;
    /** The per-composition child roster, consulted for sibling-unique names. */
    readonly roster: Roster;
}
/** The pieces of one session observation the bindings read. */
export interface SessionCut {
    /** Immutable session identity metadata. */
    readonly header: SessionHeader;
    /** The session log's events at the observation cut. */
    readonly events: readonly SessionEvent[];
    /** The projection snapshot at the same cut, when the registry is mounted. */
    readonly projections?: {
        readonly values: {
            readonly subagentTiming?: SubagentTimingProjection | undefined;
        };
    };
}
/** The slice of `ctx.sessionQuery` observation reads go through. */
export interface SessionCutSource {
    /** One immutable cut over a session's header, log, and projections. */
    observeSession(sessionId: SessionId, options: {
        signal?: AbortSignal;
        projectionMode?: 'all' | 'none';
    }): Promise<SessionCut & Disposable>;
}
/** Everything the observation handlers need from the composition. */
export interface AgentObserveDeps extends FamilySource {
    /** The session observation reader. */
    readonly observations: SessionCutSource;
}
/** One reachable family member, before any session-cut enrichment. */
export interface FamilyMember {
    /** The member's position relative to the calling session. */
    readonly relationship: AgentFamilyRelationship;
    /** The member's durable session id, as a plain string. */
    readonly id: string;
    /** Roster name, falling back to the catalog label and then the id. */
    readonly name: string;
    /** The exact live agent, when the member is resident in this host. */
    readonly agent?: Agent;
}
/** The calling session's nuclear family and its own display name. */
export interface FamilySnapshot {
    /** The calling session's roster name, catalog label, or id. */
    readonly selfName: string;
    /** Parent first, then siblings, then children; each group sorted by name. */
    readonly members: readonly FamilyMember[];
}
/** One conversation message folded out of a session event cut. */
export interface FoldedMessage {
    /** Zero-based position among the cut's conversation messages. */
    readonly index: number;
    /** The message role, taken from the persisted message. */
    readonly role: string;
    /** Wall-clock time of the log event carrying the message. */
    readonly timestamp: number;
    /** The joined text of the message's content blocks. */
    readonly text: string;
    /** Names of the tool calls an assistant message requested, when any. */
    readonly toolCalls?: readonly string[];
}
/** One bounded message preview on the `agent_observe` wire. */
export type ObserveMessagePreview = {
    /** Zero-based position among the cut's conversation messages. */
    readonly index: number;
    /** The message role, taken from the persisted message. */
    readonly role: string;
    /** Wall-clock time of the log event carrying the message. */
    readonly timestamp: number;
    /** The message text, clipped to the requested preview size. */
    readonly text: string;
    /** True when the text was clipped. */
    readonly truncated: boolean;
    /** Names of the tool calls an assistant message requested, when any. */
    readonly toolCalls?: string[];
};
/** One family member's summary on the `agent_observe` wire. */
export type ObserveAgentSummary = {
    /** Live session id; dsh keeps one durable id per session, repeated here. */
    readonly activeSessionId?: string;
    /** The durable session id. */
    readonly sessionId: string;
    /** Roster name, catalog label, or the durable id when neither is known. */
    readonly sessionName: string;
    /** The member's position relative to the calling session. */
    readonly relationship?: AgentFamilyRelationship;
    /** Coarse runtime classification, derived from the durable header. */
    readonly runtimeKind?: 'top-level' | 'subagent';
    /** Working directory recorded in the durable header. */
    readonly cwd?: string;
    /** Coarse activity status. */
    readonly status: string;
    /** True only on the calling session's own row. */
    readonly isCurrent: boolean;
    /** True while the member has an open turn and is live. */
    readonly isStreaming: boolean;
    /** Compaction state; dsh exposes no signal, always false. */
    readonly isCompacting: boolean;
    /** Attached client count; dsh exposes no signal, always zero. */
    readonly attachedClients: number;
    /** Count of conversation messages in the observed cut. */
    readonly messageCount?: number;
    /** Pending inbox messages of a live member. */
    readonly queuedCount: number;
    /** True while the member is resident in this host. */
    readonly isSessionActive: boolean;
    /** Whether the member replied after its latest user message. */
    readonly repliedSinceTask?: boolean;
    /** The member's durable parent session id, when it is a subagent child. */
    readonly parentSessionId?: string;
    /** The member's first user message, clipped to the preview cap. */
    readonly firstMessage?: string;
    /** Preview of the member's latest conversation message. */
    readonly latestMessage?: ObserveMessagePreview;
};
/**
 * Join the text of one message's content blocks, one line per block.
 *
 * @param content - the content blocks of one persisted message.
 * @returns the joined human-readable text; non-text blocks become placeholders.
 */
export declare function contentText(content: readonly ContentBlock[]): string;
/**
 * Fold one session event cut into its conversation messages, in log order.
 *
 * @param events - the session log's events at the observation cut.
 * @returns the folded conversation messages, indexed in log order.
 */
export declare function foldMessageEvents(events: readonly SessionEvent[]): FoldedMessage[];
/**
 * Clip one folded message to a bounded preview.
 *
 * @param message - the folded conversation message.
 * @param maxChars - the preview size cap, in UTF-16 code units.
 * @returns the wire preview, with `truncated` marking any clip.
 */
export declare function createMessagePreview(message: FoldedMessage, maxChars: number): ObserveMessagePreview;
/**
 * Normalize the `limit` argument of one `agent_observe.recent` call.
 *
 * @param limit - the raw requested limit, when provided.
 * @returns the bounded limit.
 */
export declare function normalizeObserveLimit(limit: number | undefined): number;
/**
 * Normalize the `max_chars` argument of one `agent_observe.recent` call.
 *
 * @param maxChars - the raw requested preview size, when provided.
 * @returns the bounded preview size.
 */
export declare function normalizeObserveMaxChars(maxChars: number | undefined): number;
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
export declare function listFamilyMembers(source: FamilySource, agent: Agent, signal: AbortSignal): Promise<FamilySnapshot>;
/**
 * The coarse runtime classification of one session, from its durable header.
 *
 * @param header - the session's durable identity metadata.
 * @returns `subagent` for a delegated child, `top-level` otherwise.
 */
export declare function headerRuntimeKind(header: SessionHeader): 'top-level' | 'subagent';
/**
 * Assemble the three observation handlers the agent-observe skill calls.
 *
 * @param deps - the composition services captured at load.
 * @returns the handler map to register on `ctx.rlmKernel`.
 */
export declare function createAgentObserveHostHandlers(deps: AgentObserveDeps): RlmHostRequestHandlers;
//# sourceMappingURL=observe.d.ts.map