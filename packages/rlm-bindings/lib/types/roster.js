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
export const RLM_PROGRESS_NOTE_MIN_INTERVAL_MS = 10_000;
/** Bounded ring of progress notes kept per child; the newest is exposed. */
export const RLM_PROGRESS_NOTE_RING_MAX = 5;
/**
 * Per-composition roster of RLM children, grouped by parent session. Name
 * reservation is synchronous so two overlapping spawns can never claim one
 * sibling name; every later lookup is O(1).
 */
export class Roster {
    parents = new Map();
    reservations = new Map();
    childParent = new Map();
    entryOf(childId) {
        const parent = this.childParent.get(childId);
        return parent === undefined ? undefined : this.parents.get(parent)?.byChild.get(childId);
    }
    /**
     * Reserve a sibling-unique child name before the spawn round trip.
     *
     * @param parent - the parent session id.
     * @param name - the requested child name.
     * @param operation - the wire type the error message names.
     * @returns a disposer releasing the reservation, for the failure path.
     */
    reserve(parent, name, operation) {
        if (this.parents.get(parent)?.byName.has(name) === true || this.reservations.get(parent)?.has(name) === true) {
            throw new Error(`${operation} name "${name}" is already used by a sibling in the current parent session`);
        }
        let names = this.reservations.get(parent);
        if (names === undefined) {
            names = new Set();
            this.reservations.set(parent, names);
        }
        names.add(name);
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            names.delete(name);
        };
    }
    /**
     * Bind a minted child id to its reserved name after admission.
     *
     * @param parent - the parent session id.
     * @param admission - the identity the child registered under.
     */
    admit(parent, admission) {
        let roster = this.parents.get(parent);
        if (roster === undefined) {
            roster = { byChild: new Map(), byName: new Map() };
            this.parents.set(parent, roster);
        }
        roster.byChild.set(admission.childId, { ...admission, notes: [] });
        roster.byName.set(admission.name, admission.childId);
        this.childParent.set(admission.childId, parent);
        this.reservations.get(parent)?.delete(admission.name);
    }
    /**
     * Drop one child from the roster, e.g. after a successful delete.
     *
     * @param parent - the parent session id.
     * @param childId - the child session id.
     */
    forget(parent, childId) {
        const roster = this.parents.get(parent);
        const entry = roster?.byChild.get(childId);
        if (roster === undefined || entry === undefined)
            return;
        roster.byChild.delete(childId);
        roster.byName.delete(entry.name);
        this.childParent.delete(childId);
    }
    /**
     * Read one admitted child of one parent.
     *
     * @param parent - the parent session id.
     * @param childId - the child session id.
     * @returns the roster entry, when the child was admitted this process.
     */
    entry(parent, childId) {
        return this.parents.get(parent)?.byChild.get(childId);
    }
    /**
     * Record one progress note from a child, throttled per child.
     *
     * @param childId - the noting session's id.
     * @param message - the validated note.
     * @param now - the wall-clock submission time.
     * @returns the throttle outcome, or `undefined` when the session is no RLM child.
     */
    noteProgress(childId, message, now) {
        const entry = this.entryOf(childId);
        if (entry === undefined)
            return undefined;
        const last = entry.lastNoteAt;
        if (last !== undefined && now - last < RLM_PROGRESS_NOTE_MIN_INTERVAL_MS) {
            return { accepted: false, retryAfterMs: RLM_PROGRESS_NOTE_MIN_INTERVAL_MS - (now - last) };
        }
        entry.lastNoteAt = now;
        entry.notes.push(message);
        if (entry.notes.length > RLM_PROGRESS_NOTE_RING_MAX)
            entry.notes.shift();
        return { accepted: true };
    }
    /**
     * The newest progress note one child reported, when any was accepted.
     *
     * @param childId - the child session id.
     * @returns the latest note.
     */
    progressNote(childId) {
        return this.entryOf(childId)?.notes.at(-1);
    }
    /**
     * Stamp the monotonic clock against one child's newest observed event time,
     * so staleness later measures only time the host was awake.
     *
     * @param childId - the child session id.
     * @param eventTime - the newest observed event time of the child log.
     * @param monotonicNow - the monotonic clock at observation time.
     */
    observeActivity(childId, eventTime, monotonicNow) {
        const entry = this.entryOf(childId);
        if (entry === undefined || entry.lastActivityEventTime === eventTime)
            return;
        entry.lastActivityEventTime = eventTime;
        entry.lastActivityMonotonicAt = monotonicNow;
    }
    /**
     * The monotonic stamp paired with one child's newest observed event.
     *
     * @param childId - the child session id.
     * @returns the stamp, when the child was admitted and observed.
     */
    activityMonotonicAt(childId) {
        return this.entryOf(childId)?.lastActivityMonotonicAt;
    }
}
//# sourceMappingURL=roster.js.map