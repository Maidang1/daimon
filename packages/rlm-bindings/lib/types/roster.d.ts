/**
 * The in-process roster of RLM children. Spawn reserves a sibling-unique name
 * synchronously, admission binds the minted child id to it, and progress notes
 * plus activity stamps accumulate against the entry. The roster is volatile:
 * every durable fact is re-derived from the session catalog and projections,
 * so a host restart simply loses names, notes, and stamps.
 *
 * @module @deepseek-ai/dsh-rlm-bindings/roster
 */
/** Minimum spacing between accepted progress notes from one child. */
export declare const RLM_PROGRESS_NOTE_MIN_INTERVAL_MS = 10000;
/** Bounded ring of progress notes kept per child; the newest is exposed. */
export declare const RLM_PROGRESS_NOTE_RING_MAX = 5;
/** One admitted RLM child, keyed by its durable child session id. */
export interface RosterChild {
    /** Durable child session id, as a plain string key. */
    readonly childId: string;
    /** Sibling-unique session name the child was admitted under. */
    readonly name: string;
    /** The `provider/model` selector the child runs on. */
    readonly model: string;
    /** One-line task label folded from the initial prompt. */
    readonly label: string;
    /** Wall-clock admission time. */
    readonly createdAt: number;
    /** Progress notes, newest last, capped at {@link RLM_PROGRESS_NOTE_RING_MAX}. */
    readonly notes: string[];
    /** Wall-clock time the latest note was accepted. */
    lastNoteAt?: number;
    /** Event time of the newest observed log event. */
    lastActivityEventTime?: number;
    /** Monotonic stamp taken when that event was first observed. */
    lastActivityMonotonicAt?: number;
}
/** Identity an admitted child is registered under. */
export interface RosterAdmission {
    /** Durable child session id, as a plain string key. */
    readonly childId: string;
    /** Sibling-unique session name. */
    readonly name: string;
    /** The `provider/model` selector the child runs on. */
    readonly model: string;
    /** One-line task label folded from the initial prompt. */
    readonly label: string;
    /** Wall-clock admission time. */
    readonly createdAt: number;
}
/** Outcome of one throttled progress-note submission. */
export type RosterNoteResult = {
    /** The note was recorded. */
    readonly accepted: true;
} | {
    /** The note was throttled. */
    readonly accepted: false;
    /** Milliseconds until the next note can be accepted. */
    readonly retryAfterMs: number;
};
/**
 * Per-composition roster of RLM children, grouped by parent session. Name
 * reservation is synchronous so two overlapping spawns can never claim one
 * sibling name; every later lookup is O(1).
 */
export declare class Roster {
    private readonly parents;
    private readonly reservations;
    private readonly childParent;
    private entryOf;
    /**
     * Reserve a sibling-unique child name before the spawn round trip.
     *
     * @param parent - the parent session id.
     * @param name - the requested child name.
     * @param operation - the wire type the error message names.
     * @returns a disposer releasing the reservation, for the failure path.
     */
    reserve(parent: string, name: string, operation: string): () => void;
    /**
     * Bind a minted child id to its reserved name after admission.
     *
     * @param parent - the parent session id.
     * @param admission - the identity the child registered under.
     */
    admit(parent: string, admission: RosterAdmission): void;
    /**
     * Drop one child from the roster, e.g. after a successful delete.
     *
     * @param parent - the parent session id.
     * @param childId - the child session id.
     */
    forget(parent: string, childId: string): void;
    /**
     * Read one admitted child of one parent.
     *
     * @param parent - the parent session id.
     * @param childId - the child session id.
     * @returns the roster entry, when the child was admitted this process.
     */
    entry(parent: string, childId: string): RosterChild | undefined;
    /**
     * Record one progress note from a child, throttled per child.
     *
     * @param childId - the noting session's id.
     * @param message - the validated note.
     * @param now - the wall-clock submission time.
     * @returns the throttle outcome, or `undefined` when the session is no RLM child.
     */
    noteProgress(childId: string, message: string, now: number): RosterNoteResult | undefined;
    /**
     * The newest progress note one child reported, when any was accepted.
     *
     * @param childId - the child session id.
     * @returns the latest note.
     */
    progressNote(childId: string): string | undefined;
    /**
     * Stamp the monotonic clock against one child's newest observed event time,
     * so staleness later measures only time the host was awake.
     *
     * @param childId - the child session id.
     * @param eventTime - the newest observed event time of the child log.
     * @param monotonicNow - the monotonic clock at observation time.
     */
    observeActivity(childId: string, eventTime: number, monotonicNow: number): void;
    /**
     * The monotonic stamp paired with one child's newest observed event.
     *
     * @param childId - the child session id.
     * @returns the stamp, when the child was admitted and observed.
     */
    activityMonotonicAt(childId: string): number | undefined;
}
//# sourceMappingURL=roster.d.ts.map