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
import type { Agent } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { ContinuableStart, ContinuableStartSpec, SubagentCatalogEntry, SubagentTimingProjection } from '@deepseek-ai/dsh-subagent';
import type { RlmHostRequestHandlers } from '@deepseek-ai/dsh-rlm-kernel';
import type { BashNoticeBoard } from './bash.ts';
import type { ModelCatalog } from './models.ts';
import type { Roster } from './roster.ts';
/** The slice of `ctx.subagents` the bindings drive. */
export interface SubagentBackend {
    /** Establish one continuable child and return once its prompt is accepted. */
    startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>;
    /** The current direct-child catalog of one parent session. */
    listChildren(parent: SessionId, signal?: AbortSignal): Promise<SubagentCatalogEntry[]>;
    /** Release selected resident continuable direct children of one parent. */
    drainContinuableChildren(parent: Agent, childIds: readonly SessionId[]): Promise<void>;
}
/** The pieces of one child observation the bindings read. */
export interface ChildObservation {
    /** The child log's events at the observation cut. */
    readonly events: readonly SessionEvent[];
    /** The projection snapshot at the same cut, when the registry is mounted. */
    readonly projections?: {
        readonly values: {
            readonly subagentTiming?: SubagentTimingProjection | undefined;
        };
    };
}
/** The slice of `ctx.sessionQuery` the bindings read through. */
export interface ObservationSource {
    /** One immutable cut over a child session's log and projections. */
    observeSession(sessionId: SessionId, options: {
        signal?: AbortSignal;
        projectionMode?: 'all' | 'none';
    }): Promise<ChildObservation & Disposable>;
}
/** Everything the host handlers need from the composition, captured at load. */
export interface RlmBindingDeps {
    /** The continuable subagent manager. */
    readonly subagents: SubagentBackend;
    /** The advertised model catalog. */
    readonly models: ModelCatalog;
    /** The session observation reader. */
    readonly observations: ObservationSource;
    /** The per-composition child roster. */
    readonly roster: Roster;
    /** Registry name of the spawn provider children are created through. */
    readonly providerName: string;
    /** Display path a child's `session_dir` / `session_file` reports. */
    readonly sessionDir: (childId: string) => string;
    /** Pending background-command completion notices, per session. */
    readonly notices: BashNoticeBoard;
}
/** One `rlm.list_subagents` row, the kernel roster's wire shape. */
export type RlmSubagentRow = {
    /** Durable child session id. */
    readonly rlm_child_id: string;
    /** The same id; a dsh continuable child has one durable session id. */
    readonly active_session_id: string;
    /** The same id; a dsh continuable child has one durable session id. */
    readonly session_id: string;
    /** Roster name, falling back to the catalog label. */
    readonly session_name: string;
    /** Stable display path; no directory is created. */
    readonly session_dir: string;
    /** Registry status. */
    readonly status: 'running' | 'completed' | 'error';
    /** Count of the child's tool calls, omitted while zero. */
    readonly tool_use_count?: number;
    /** Accumulated turn time in milliseconds. */
    readonly duration_ms?: number;
    /** Compacted text of the child's last non-empty assistant message. */
    readonly answer_preview?: string;
    /** Whether the child replied after its latest user message. */
    readonly replied_since_task?: boolean;
    /** The child's newest accepted progress note. */
    readonly progress_note?: string;
    /** One-line task label, capped for the kernel roster. */
    readonly label?: string;
    /** Wall-clock time of the child log's last event. */
    readonly last_activity_at?: number;
    /** Staleness of a running child past the threshold. */
    readonly activity_stale_ms?: number;
};
/** One `rlm.collect` result entry. */
export type RlmCollectRow = {
    /** Durable child session id. */
    readonly rlm_child_id: string;
    /** Roster name, falling back to the catalog label. */
    readonly session_name: string;
    /** Stable display path; no directory is created. */
    readonly session_dir: string;
    /** Run status. */
    readonly status: 'queued' | 'running' | 'done' | 'error';
    /** True once the child reached a terminal state. */
    readonly settled: boolean;
    /** Compacted text of the child's last non-empty assistant message. */
    readonly answer_preview?: string;
    /** Why the child failed, when it did. */
    readonly error?: string;
    /** Accumulated turn time in milliseconds. */
    readonly duration_ms?: number;
    /** Count of the child's tool calls, omitted while zero. */
    readonly tool_use_count?: number;
    /** Whether the child replied after its latest user message. */
    readonly replied_since_task?: boolean;
};
/**
 * Assemble the nine host handlers the bindings answer.
 *
 * @param deps - the composition services captured at load.
 * @returns the handler map to register on `ctx.rlmKernel`.
 */
export declare function createRlmHostHandlers(deps: RlmBindingDeps): RlmHostRequestHandlers;
//# sourceMappingURL=subagents.d.ts.map