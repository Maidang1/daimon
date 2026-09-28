/**
 * Pure harness-state operations shared by every consumer of the
 * `ctx.rlmHarness` seam. Normalization, merge, and refinement recording hold no
 * I/O and no clock of their own, so the seam's providers and its tests settle
 * the same state transitions.
 *
 * @module @deepseek-ai/dsh-rlm-harness/state
 */
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type { HarnessEntry, HarnessEntryInput, HarnessKind, HarnessRefinementProposal, HarnessState } from './types.ts';
/** Every entry kind, in the order a projection renders them. */
export declare const HARNESS_KINDS: readonly HarnessKind[];
/** Default grouping path inside a kind. */
export declare const DEFAULT_HARNESS_PATH = "general";
/** Default authorship marker. */
export declare const DEFAULT_HARNESS_SOURCE = "agent";
/** Failure raised when a harness operation cannot be applied. */
export declare class HarnessStateError extends Error {
    /**
     * @param message - description of the rejected operation.
     * @param options - error options carrying the originating cause.
     */
    constructor(message: string, options?: ErrorOptions);
}
/**
 * The empty state: every kind present and empty, no refinement history.
 *
 * @returns a fresh state with no entries and no refinements.
 */
export declare function emptyHarnessState(): HarnessState;
/**
 * Normalize one caller-supplied entry into a stored record.
 *
 * @param input - the entry as the caller supplied it.
 * @param previous - the record being updated, when the call is an update.
 * @param now - the caller's clock reading for this write.
 * @returns the normalized record.
 * @throws {HarnessStateError} when the input carries no usable identity or body.
 */
export declare function normalizeEntry(input: HarnessEntryInput, previous: HarnessEntry | undefined, now: string): HarnessEntry;
/**
 * Apply one entry write to a state, leaving the input untouched.
 *
 * @param state - the state to write into.
 * @param entry - the normalized record to store.
 * @returns the state with the entry stored under its kind.
 */
export declare function withEntry(state: HarnessState, entry: HarnessEntry): HarnessState;
/**
 * Apply one refinement proposal and record its event.
 *
 * @param state - the state the proposal applies to.
 * @param proposal - the proposed writes and the pass's evidence.
 * @param now - the caller's clock reading for this pass.
 * @param id - the identity the caller minted for the event.
 * @returns the state after the proposal, including its recorded event.
 */
export declare function applyRefinement(state: HarnessState, proposal: HarnessRefinementProposal, now: string, id: string): HarnessState;
/**
 * The state with every refinement after `eventId` rolled back.
 *
 * @param state - the current state.
 * @param eventId - identity of the refinement event to roll back to.
 * @returns the state truncated at that event, or the input when the event is unknown.
 */
export declare function rollbackToEvent(state: HarnessState, eventId: string): HarnessState;
/**
 * The JSON a projection renders for one entry.
 *
 * @param entry - the entry to project.
 * @returns the entry as a lossless JSON value.
 */
export declare function entryJson(entry: HarnessEntry): Readonly<Record<string, JsonValue>>;
//# sourceMappingURL=state.d.ts.map