/**
 * Host handlers answering the RLM Python runtime's `goal.*` host requests,
 * the wire contract of the bundled goal skill. Payload validation and error
 * messages mirror the reference host implementation, because the kernel
 * turns a thrown handler into the error reply the model reads verbatim. The
 * substrate is `ctx.goals`' round-budgeted goal domain: token usage and
 * active-time accounting do not exist here, so the reply reports them as
 * zero or absent, and the completion report names the round budget instead.
 *
 * @module @deepseek-ai/dsh-rlm-bindings/goal
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { RlmHostRequestHandlers } from '@deepseek-ai/dsh-rlm-kernel';
/** Durable goal lifecycle phases the substrate reports. */
export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete';
/** Machine-routable and human-readable explanation for a blocked goal. */
export interface GoalBlockReason {
    /** Stable lower-kebab-case classification chosen by the blocking policy. */
    readonly code: string;
    /** Non-empty explanation shown to humans and models. */
    readonly message: string;
}
/** Compare-and-set identity of one exact goal revision. */
export interface GoalRef {
    /** Stable goal identity. */
    readonly id: string;
    /** Positive revision; every durable mutation increments it. */
    readonly revision: number;
}
/** The goal fields the bindings read off the substrate's live view. */
export interface GoalView extends GoalRef {
    /** Human-requested completion objective. */
    readonly objective: string;
    /** Durable lifecycle phase. */
    readonly phase: GoalPhase;
    /** Present exactly while `phase` is `blocked`. */
    readonly blockedReason?: GoalBlockReason;
    /** Total admitted goal-round cap. */
    readonly maxGoalRounds: number;
    /** Highest admitted round number for this goal. */
    readonly roundsStarted: number;
    /** Epoch milliseconds of the create mutation. */
    readonly createdAt: number;
    /** Epoch milliseconds of the latest mutation. */
    readonly updatedAt: number;
}
/** The slice of `ctx.goals` the goal bindings drive. */
export interface GoalBackend {
    /** Read the current goal of one exact live agent, when one exists. */
    get(agent: Agent): GoalView | undefined;
    /** Create and arm a goal; a completed goal may be replaced. */
    create(agent: Agent, request: {
        readonly objective: string;
    }): GoalView;
    /** Mark a current non-complete goal revision complete. */
    complete(agent: Agent, ref: GoalRef): GoalView;
}
/** Everything the goal host handlers need from the composition. */
export interface GoalBindingDeps {
    /** The session goal service. */
    readonly goals: GoalBackend;
}
/** Wire status vocabulary of the kernel-side goal skill. */
export type WireGoalStatus = 'active' | 'paused' | 'budget_limited' | 'complete' | 'error';
/** One serialized goal, the kernel-side skill's snake_case shape. */
export type SerializedGoal = {
    /** Stable goal identity. */
    readonly goal_id: string;
    /** The trimmed objective. */
    readonly objective: string;
    /** Lifecycle status mapped onto the skill's vocabulary. */
    readonly status: WireGoalStatus;
    /** Tokens consumed; the substrate keeps no token accounting, always zero. */
    readonly tokens_used: number;
    /** Active seconds; the substrate keeps no time accounting, always zero. */
    readonly time_used_seconds: number;
    /** Epoch milliseconds of the create mutation. */
    readonly created_at: number;
    /** Epoch milliseconds of the latest mutation. */
    readonly updated_at: number;
    /** Token budget when the substrate carries one; this substrate never does. */
    readonly token_budget?: number;
};
/** Reply payload of every `goal.*` wire. */
export type GoalHostResult = {
    /** The current goal, or null when none exists. */
    readonly goal: SerializedGoal | null;
    /** Remaining token budget, or null without token accounting. */
    readonly remaining_tokens: number | null;
    /** Model-facing budget report, present on a completing `goal.complete`. */
    readonly completion_budget_report: string | null;
};
/**
 * Mount the three `goal.*` host handlers of the kernel-side goal skill.
 *
 * @param deps - the composition services the handlers drive.
 * @returns handlers keyed by wire type, for `registerHostRequestHandlers`.
 */
export declare function createGoalHostHandlers(deps: GoalBindingDeps): RlmHostRequestHandlers;
//# sourceMappingURL=goal.d.ts.map