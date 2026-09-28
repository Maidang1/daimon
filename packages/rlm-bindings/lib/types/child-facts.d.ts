/**
 * Pure folds over one child session's event cut. The bindings read each child
 * through `ctx.sessionQuery`, and this module turns the raw events plus the
 * `subagentTiming` projection into the bounded facts the roster rows carry.
 *
 * @module @deepseek-ai/dsh-rlm-bindings/child-facts
 */
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session';
import type { SubagentTimingProjection } from '@deepseek-ai/dsh-subagent';
/** A running child with no tracked activity for this long reports staleness. */
export declare const RLM_CHILD_STALE_ACTIVITY_THRESHOLD_MS: number;
/** Facts folded from one child session's event cut and timing projection. */
export interface ChildFacts {
    /** True while the child has an open turn — the authoritative running signal. */
    readonly running: boolean;
    /** Whether the latest closed turn completed normally, when one has closed. */
    readonly lastTurnCompleted?: boolean;
    /** Accumulated turn time in milliseconds, including the open turn's cut span. */
    readonly durationMs?: number;
    /** Count of `tool/call` events, omitted while zero. */
    readonly toolUseCount?: number;
    /** Compacted text of the last non-empty assistant message. */
    readonly answerPreview?: string;
    /** Whether the last assistant message is newer than the last user message. */
    readonly repliedSinceTask?: boolean;
    /** Wall-clock time of the child log's last event. */
    readonly lastActivityAt?: number;
    /** Why the latest closed turn ended, when it ended abnormally. */
    readonly error?: string;
}
/**
 * Human-readable account of one abnormally ended turn, for `collect` rows.
 *
 * @param reason - the closing turn's end reason, when the log recorded one.
 * @returns the error text for the row.
 */
export declare function formatTurnEndError(reason: TurnEndReason | undefined): string;
/**
 * Lazily computed staleness for a running child: how long since the last
 * tracked activity, once past the threshold. The smaller of the wall and
 * monotonic deltas bounds the value to time the host was actually awake, so a
 * laptop sleep cannot inflate it. Computed at snapshot build time only.
 *
 * @param running - whether the child currently has an open turn.
 * @param lastActivityAt - wall-clock time of the child log's last event.
 * @param lastActivityMonotonicAt - monotonic stamp taken when that event was first observed.
 * @returns whole milliseconds of staleness at or over the threshold, else `undefined`.
 */
export declare function rlmActivityStaleMs(running: boolean, lastActivityAt: number | undefined, lastActivityMonotonicAt: number | undefined): number | undefined;
/**
 * Fold one child session's event cut and timing projection into roster facts.
 *
 * @param events - the child log's events at the observation cut.
 * @param timing - the `subagentTiming` projection at the same cut, when mounted.
 * @returns the folded facts; absent fields are omitted, never `undefined`-valued.
 */
export declare function foldChildFacts(events: readonly SessionEvent[], timing: SubagentTimingProjection | undefined): ChildFacts;
//# sourceMappingURL=child-facts.d.ts.map