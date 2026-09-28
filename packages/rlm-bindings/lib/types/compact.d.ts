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
import type { Session } from '@deepseek-ai/dsh-session';
import type { RlmHostRequestHandlers } from '@deepseek-ai/dsh-rlm-kernel';
/**
 * The agent surface an explicit compaction runs against. This is the
 * structural minimum of the compaction seam's manual-compaction context; the
 * composition's `Agent` satisfies it.
 */
export interface CompactionAgent {
    /** The live session whose durable history is compacted. */
    readonly session: Session;
    /** The provider/model route guiding summarization. */
    readonly options: {
        readonly provider?: string;
        readonly model?: string;
    };
    /** Serialize one idle-phase maintenance task against driver turns. */
    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>;
}
/** The slice of `ctx.compaction` the bindings drive. */
export interface CompactBackend {
    /**
     * Compact useful history once the agent is idle.
     * @param agent - idle agent whose durable history should be compacted.
     * @param signal - cancellation scoped to this compaction request.
     * @returns settlement of the attempt; `null` marks a no-op.
     */
    compactNow(agent: CompactionAgent, signal: AbortSignal): Promise<unknown>;
}
/** The slice of `ctx.tokenMeter` the bindings read for context pressure. */
export interface CompactUsageSource {
    /**
     * Measure current request pressure of one session.
     * @param session - session to measure.
     * @returns a snapshot carrying the total request-and-response tokens.
     */
    measure(session: Session): {
        readonly totalTokens: number;
    };
}
/** The slice of `ctx.llm` compact status resolves context capacity through. */
export interface CompactModelCatalog {
    /**
     * Resolve adapter-owned metadata of one exact provider/model route.
     * @param provider - registered provider route to inspect.
     * @param model - exact model id on that route.
     * @param signal - optional cancellation for the adapter lookup.
     * @returns the route's metadata, with context capacity when known.
     */
    resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{
        readonly context?: {
            readonly contextWindow: number;
        };
    }>;
}
/** Everything the compact host handlers need from the composition, captured at load. */
export interface CompactBindingDeps {
    /** The compaction engine running the deferred request. */
    readonly compaction: CompactBackend;
    /** The token meter reporting current pressure. */
    readonly usage: CompactUsageSource;
    /** The model catalog resolving the route's context window. */
    readonly models: CompactModelCatalog;
}
/**
 * Assemble the two host handlers the compact skill answers.
 *
 * @param deps - the composition services captured at load.
 * @returns the handler map to register on `ctx.rlmKernel`.
 */
export declare function createCompactHostHandlers(deps: CompactBindingDeps): RlmHostRequestHandlers;
//# sourceMappingURL=compact.d.ts.map