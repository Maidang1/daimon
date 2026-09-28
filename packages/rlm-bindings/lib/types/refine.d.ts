/**
 * The `refine.run` / `refine.status` host wires: continual harness refinement
 * scheduling for the kernel's refine skill. A run request never refines
 * mid-cell; it records a per-agent pending request that the `agent/turn-stopping`
 * boundary listener consumes, steering a refinement notice into the session so
 * the agent performs the refinement itself and resumes automatically. This
 * host has no separate refinement planner, so the notice replaces the side
 * pass the reference implementation runs at the same boundary.
 *
 * @module @deepseek-ai/dsh-rlm-bindings/refine
 */
import type { ContextFormed, UserMessage } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { RlmHostRequestHandlers } from '@deepseek-ai/dsh-rlm-kernel';
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        /** Refinement request notices steered into the requesting session. */
        'rlm-bindings': {
            kind: 'rlm-bindings';
        } & ContextFormed;
    }
}
/** One scheduled refinement request, as merged `refine.run` arguments carry it. */
export interface RefineRequest {
    /** Focus instructions for the refinement pass. */
    readonly instructions?: string;
    /** Whether the refinement targets the global, cross-session harness store. */
    readonly global?: boolean;
}
/**
 * Per-agent scheduled refinement state. The state is in-process and volatile:
 * a host restart drops pending requests and in-flight stamps, matching the
 * roster's durability policy.
 */
export declare class RefineRequests {
    private readonly states;
    /**
     * Schedule one refinement for an agent, merging over any earlier request of
     * the same turn: a repeated `refine.run` only updates the fields it carries.
     *
     * @param agentId - the requesting session's id.
     * @param update - the validated `refine.run` arguments.
     */
    schedule(agentId: string, update: RefineRequest): void;
    /**
     * Whether one agent has a refinement queued for its current turn.
     *
     * @param agentId - the session's id.
     * @returns the pending flag of the `refine.status` reply.
     */
    isPending(agentId: string): boolean;
    /**
     * Whether one agent's refinement was consumed at a turn boundary and its
     * notice has not yet worked through the reopened turn.
     *
     * @param agentId - the session's id.
     * @returns the in-flight flag of the `refine.status` reply.
     */
    isInFlight(agentId: string): boolean;
    /**
     * Take one agent's pending request at its turn boundary, marking the
     * refinement in flight.
     *
     * @param agentId - the session whose turn is closing.
     * @returns the scheduled request, or `undefined` when none is pending.
     */
    consume(agentId: string): RefineRequest | undefined;
    /**
     * Clear one agent's in-flight stamp when its turn boundary arrives with no
     * further pending request.
     *
     * @param agentId - the session whose turn is closing.
     */
    settle(agentId: string): void;
    /**
     * Drop every refinement state of one agent, e.g. on disposal.
     *
     * @param agentId - the disposed session's id.
     */
    forget(agentId: string): void;
}
/** Everything the refinement handlers and boundary listener share. */
export interface RefineDeps {
    /** Per-agent scheduled refinement state. */
    readonly requests: RefineRequests;
}
/**
 * Format the model-facing text of one refinement request notice.
 *
 * @param request - the scheduled refinement consumed at the turn boundary.
 * @returns the header line, the instruction body, and the optional focus.
 */
export declare function formatRefineRequestNotice(request: RefineRequest): string;
/**
 * Build the steered user message carrying one refinement request.
 *
 * @param request - the scheduled refinement consumed at the turn boundary.
 * @returns the identified message to steer into the requesting session.
 */
export declare function createRefineRequestMessage(request: RefineRequest): UserMessage;
/** The `agent/turn-stopping` payload the boundary listener reads. */
export interface RefineTurnStoppingPayload {
    /** The agent whose turn is at its stop boundary. */
    readonly agent: Agent;
}
/**
 * Build the `agent/turn-stopping` listener that services scheduled
 * refinements. A pending request is consumed and steered into the session as
 * a refinement notice; the machine re-reads the inbox, so the turn reopens
 * and the agent resumes with the notice. A boundary without a pending request
 * settles the in-flight stamp of the previous consumption.
 *
 * @param deps - the shared per-agent refinement state.
 * @returns the serial turn-boundary listener.
 */
export declare function createRefineTurnStopping(deps: RefineDeps): (payload: RefineTurnStoppingPayload) => void;
/**
 * Assemble the two host handlers the refine skill's wires answer.
 *
 * @param deps - the shared per-agent refinement state.
 * @returns the handler map to register on `ctx.rlmKernel`.
 */
export declare function createRefineHostHandlers(deps: RefineDeps): RlmHostRequestHandlers;
//# sourceMappingURL=refine.d.ts.map