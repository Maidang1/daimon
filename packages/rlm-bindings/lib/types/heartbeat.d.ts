/**
 * Internal RLM heartbeats: recurring prompts the model manages through the
 * `rlm_heartbeat.*` host requests. The schedule plugin's `ScheduleRuntime`
 * only folds durable `schedule/change` reminder records — it has no pause,
 * resume, label, delivery-mode, or run-statistics semantics and is not
 * exposed as a context service — so the bindings keep their own minimal
 * heartbeat table, persisted as one JSON file, and fire it with a single
 * re-armed timer. Due beats are steered into the owning session the way the
 * reference host delivers them: `steer` interrupts the current turn,
 * `follow_up` waits for it to finish.
 *
 * @module @deepseek-ai/dsh-rlm-bindings/heartbeat
 */
import type { ContextFormed, UserMessage } from '@deepseek-ai/dsh-llm';
import type { RlmHostRequestHandlers } from '@deepseek-ai/dsh-rlm-kernel';
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        /** Scheduled heartbeat prompts delivered into the owning session. */
        'rlm-heartbeat': {
            kind: 'rlm-heartbeat';
        } & ContextFormed;
    }
}
/** Schedule a heartbeat falls back to when the request names no interval. */
export declare const DEFAULT_HEARTBEAT_SCHEDULE = "every 5m";
/** Delivery mode a heartbeat falls back to when the request names none. */
export declare const DEFAULT_HEARTBEAT_DELIVERY_MODE: HeartbeatDeliveryMode;
/** Shortest recurring interval the schedule parser accepts. */
export declare const MIN_HEARTBEAT_INTERVAL_MS = 10000;
/** How a due heartbeat reaches its session: interrupt, or wait for the turn. */
export type HeartbeatDeliveryMode = 'steer' | 'follow_up';
/** Lifecycle of one heartbeat; cancelled rows stay listed for `include_inactive`. */
export type HeartbeatStatus = 'active' | 'paused' | 'cancelled';
/** Recurring schedule of one heartbeat: a fixed interval or a cron expression. */
export type HeartbeatSchedule = {
    /** Fixed millisecond interval between runs. */
    readonly kind: 'interval';
    /** Normalized schedule text, echoed in the delivered prompt header. */
    readonly expression: string;
    /** Fixed millisecond interval between runs. */
    readonly intervalMs: number;
} | {
    /** Five-field cron expression, evaluated in local time. */
    readonly kind: 'cron';
    /** Cron expression with any `@alias` already expanded. */
    readonly expression: string;
};
/** A schedule rule the parser accepts, including the rejected one-shot forms. */
export type HeartbeatScheduleRule = HeartbeatSchedule | {
    /** One-shot `in <delay>` or `at <date>` rule; heartbeats reject these. */
    readonly kind: 'once';
    /** Normalized schedule text. */
    readonly expression: string;
};
/** One persisted heartbeat row. */
export interface HeartbeatJob {
    /** Stable identity minted at creation. */
    readonly id: string;
    /** Owning session the beat is delivered into. */
    readonly sessionId: string;
    /** Lifecycle status. */
    readonly status: HeartbeatStatus;
    /** Optional human-readable label; absent when never set or cleared. */
    readonly label?: string;
    /** Delivery mode for a busy session. */
    readonly deliveryMode: HeartbeatDeliveryMode;
    /** Trimmed prompt text delivered on every beat. */
    readonly instruction: string;
    /** Recurring schedule. */
    readonly schedule: HeartbeatSchedule;
    /** ISO creation time. */
    readonly createdAt: string;
    /** ISO time of the last mutation. */
    readonly updatedAt: string;
    /** ISO time of the next run; absent while paused or cancelled. */
    readonly nextRunAt?: string;
    /** ISO time of the last delivery. */
    readonly lastRunAt?: string;
    /** Message of the last failed or skipped delivery. */
    readonly lastError?: string;
    /** Number of deliveries attempted. */
    readonly runCount: number;
}
/** One heartbeat row in the wire reply's snake_case shape. */
export type HeartbeatWireRow = {
    /** Stable identity. */
    readonly id: string;
    /** Lifecycle status. */
    readonly status: HeartbeatStatus;
    /** Human-readable label, or `null`. */
    readonly label: string | null;
    /** Delivery mode for a busy session. */
    readonly delivery_mode: HeartbeatDeliveryMode;
    /** Prompt text delivered on every beat. */
    readonly instruction: string;
    /** Recurring schedule. */
    readonly schedule: {
        /** Rule discriminator. */
        readonly kind: 'interval' | 'cron';
        /** Normalized schedule text. */
        readonly expression: string;
        /** Fixed interval, present only for `interval` rules. */
        readonly intervalMs?: number;
    };
    /** ISO creation time. */
    readonly created_at: string;
    /** ISO time of the last mutation. */
    readonly updated_at: string;
    /** ISO time of the next run, or `null` while paused or cancelled. */
    readonly next_run_at: string | null;
    /** ISO time of the last delivery, or `null`. */
    readonly last_run_at: string | null;
    /** Message of the last failed or skipped delivery, or `null`. */
    readonly last_error: string | null;
    /** Number of deliveries attempted. */
    readonly run_count: number;
};
/** Fields accepted when creating one heartbeat. */
export interface CreateHeartbeatInput {
    /** Owning session the beat is delivered into. */
    readonly sessionId: string;
    /** Prompt text delivered on every beat. */
    readonly instruction: string;
    /** Schedule text; defaults to {@link DEFAULT_HEARTBEAT_SCHEDULE}. */
    readonly interval?: string;
    /** Optional human-readable label. */
    readonly label?: string;
    /** Delivery mode; defaults to {@link DEFAULT_HEARTBEAT_DELIVERY_MODE}. */
    readonly deliveryMode?: HeartbeatDeliveryMode;
    /** Clock override for deterministic tests. */
    readonly now?: Date;
}
/** Fields accepted when updating one heartbeat; at least one is required. */
export interface UpdateHeartbeatInput {
    /** Replacement prompt text. */
    readonly instruction?: string;
    /** Replacement schedule text. */
    readonly interval?: string;
    /** Replacement label; whitespace clears it. */
    readonly label?: string;
    /** Pause or resume the beat. */
    readonly status?: 'pause' | 'resume';
    /** Replacement delivery mode. */
    readonly deliveryMode?: HeartbeatDeliveryMode;
    /** Clock override for deterministic tests. */
    readonly now?: Date;
}
/**
 * Parse schedule text the way the reference host does: `in <delay>` and
 * `at <date>` produce a one-shot rule the heartbeat store rejects,
 * `every <n><unit>` produces a fixed interval of at least ten seconds, and
 * anything else is read as a cron expression with `@alias` expansion.
 *
 * @param input - the raw schedule text.
 * @param now - the instant relative times anchor to.
 * @returns the parsed rule and its first run.
 */
export declare function parseHeartbeatSchedule(input: string, now?: Date): {
    schedule: HeartbeatScheduleRule;
    nextRunAt: Date;
};
/**
 * Normalize a requested interval into schedule text: a missing interval falls
 * back to the default, and a bare `5m`-style duration gains the `every` prefix.
 *
 * @param input - the requested interval, or `undefined`.
 * @returns the schedule text to parse.
 */
export declare function normalizeHeartbeatSchedule(input: string | undefined): string;
/**
 * Normalize a requested delivery mode, rejecting anything outside the vocabulary.
 *
 * @param value - the raw `delivery_mode` payload member.
 * @returns the delivery mode, or `undefined` when none was given.
 */
export declare function normalizeHeartbeatDeliveryMode(value: unknown): HeartbeatDeliveryMode | undefined;
/**
 * Compute the next run of a recurring schedule after one instant.
 *
 * @param schedule - the recurring schedule.
 * @param after - the instant to start from.
 * @returns the next run.
 */
export declare function nextRunAtForSchedule(schedule: HeartbeatSchedule, after: Date): Date;
/**
 * The persistent heartbeat table: one JSON file holding every session's rows.
 * Each operation re-reads the file so concurrent mutations never ride on a
 * stale in-memory copy, and writes go through a rename so a crash mid-write
 * cannot truncate the store.
 */
export declare class HeartbeatStore {
    private readonly filePath;
    /**
     * Open the store at one file path; the file is created on the first write.
     *
     * @param filePath - absolute path of the JSON store file.
     */
    constructor(filePath: string);
    /**
     * List one session's heartbeats, soonest next run first, paused and cancelled last.
     *
     * @param sessionId - the owning session.
     * @param options - pass `includeInactive` to keep cancelled rows.
     * @returns the matching rows.
     */
    list(sessionId: string, options?: {
        includeInactive?: boolean;
    }): HeartbeatJob[];
    /**
     * Create one active heartbeat. One-shot schedules and empty instructions
     * are rejected with the reference host's messages.
     *
     * @param input - the creation fields.
     * @returns the persisted row.
     */
    create(input: CreateHeartbeatInput): HeartbeatJob;
    /**
     * Update one of a session's heartbeats. A cancelled row matches but no
     * longer updates, and an unknown id matches nothing; both return `undefined`.
     *
     * @param sessionId - the owning session.
     * @param id - the heartbeat identity.
     * @param update - the fields to change.
     * @returns the updated row, or `undefined`.
     */
    update(sessionId: string, id: string, update: UpdateHeartbeatInput): HeartbeatJob | undefined;
    /**
     * Cancel one of a session's heartbeats, keeping the row for `include_inactive`.
     *
     * @param sessionId - the owning session.
     * @param id - the heartbeat identity.
     * @param now - the cancellation time.
     * @returns the cancelled row, or `undefined` when nothing matched.
     */
    delete(sessionId: string, id: string, now?: Date): HeartbeatJob | undefined;
    /**
     * Cancel every live heartbeat of one session, for session teardown.
     *
     * @param sessionId - the owning session.
     * @param now - the cancellation time.
     * @returns the rows that were still live.
     */
    cancelSession(sessionId: string, now?: Date): HeartbeatJob[];
    /**
     * The earliest due time of any active heartbeat, across every session.
     *
     * @returns the epoch milliseconds of the next run, or `undefined` when idle.
     */
    nextActiveRunAt(): number | undefined;
    /**
     * Every active heartbeat due at one instant, soonest first.
     *
     * @param now - the instant to test against.
     * @returns the due rows.
     */
    dueJobs(now: Date): HeartbeatJob[];
    /**
     * Record one attempted delivery: the run count and last-run time always
     * advance, a failure lands in `lastError`, and a success clears it.
     *
     * @param id - the heartbeat identity.
     * @param result - the delivery outcome.
     * @returns the updated row, or `undefined` when the row is gone or no longer active.
     */
    recordRun(id: string, result: {
        now?: Date;
        error?: unknown;
    }): HeartbeatJob | undefined;
    /**
     * Record one skipped beat: the schedule advances and the reason lands in
     * `lastError`, but the run count and last-run time stay untouched.
     *
     * @param id - the heartbeat identity.
     * @param error - why the beat was skipped.
     * @param now - the skip time.
     * @returns the updated row, or `undefined` when the row is gone or no longer active.
     */
    recordSkip(id: string, error: string, now?: Date): HeartbeatJob | undefined;
    private readJobs;
    private writeJobs;
}
/**
 * Format the model-facing text of one heartbeat beat.
 *
 * @param job - the heartbeat that is due.
 * @returns the header line plus the instruction.
 */
export declare function formatHeartbeatPrompt(job: HeartbeatJob): string;
/**
 * Build the user message one due beat delivers into the owning session.
 *
 * @param job - the heartbeat that is due.
 * @returns the identified message to steer or queue.
 */
export declare function createHeartbeatMessage(job: HeartbeatJob): UserMessage;
/** The slice of a live agent the scheduler delivers through. */
export interface HeartbeatDeliveryTarget {
    /** Interrupt the current turn with the message. */
    steer(message: UserMessage): void;
    /** Queue the message behind the current turn. */
    followup(message: UserMessage): void;
}
/** Everything the heartbeat scheduler needs from the composition. */
export interface HeartbeatSchedulerDeps {
    /** The persisted heartbeat table. */
    readonly store: HeartbeatStore;
    /** Resolve the live delivery target of one session, when it is loaded. */
    readonly resolveAgent: (sessionId: string) => HeartbeatDeliveryTarget | undefined;
    /** Clock override for deterministic tests. */
    readonly now?: () => Date;
    /** Sink for internal delivery failures; defaults to swallowing them. */
    readonly onError?: (error: unknown) => void;
}
/**
 * The heartbeat controller behind the `rlm_heartbeat.*` host requests:
 * CRUD against the store plus one re-armed timer that delivers due beats.
 * Mutations wake the timer, and every fire re-arms it from the persisted
 * table, so the file stays the single source of truth.
 */
export declare class HeartbeatScheduler {
    private readonly deps;
    private timer;
    private disposed;
    /**
     * Create the scheduler; {@link start} arms the first timer.
     *
     * @param deps - the composition services captured at load.
     */
    constructor(deps: HeartbeatSchedulerDeps);
    /** Arm the timer from the persisted table. */
    start(): void;
    /** Stop future deliveries and cancel the armed timer. */
    dispose(): void;
    /**
     * List one session's heartbeats.
     *
     * @param sessionId - the owning session.
     * @param options - pass `includeInactive` to keep cancelled rows.
     * @returns the matching rows.
     */
    list(sessionId: string, options?: {
        includeInactive?: boolean;
    }): HeartbeatJob[];
    /**
     * Create one heartbeat and re-arm the timer.
     *
     * @param input - the creation fields, minus the clock.
     * @returns the persisted row.
     */
    create(input: CreateHeartbeatInput): HeartbeatJob;
    /**
     * Update one heartbeat and re-arm the timer when a live row changed.
     *
     * @param sessionId - the owning session.
     * @param id - the heartbeat identity.
     * @param update - the fields to change, minus the clock.
     * @returns the updated row, or `undefined`.
     */
    update(sessionId: string, id: string, update: UpdateHeartbeatInput): HeartbeatJob | undefined;
    /**
     * Cancel one heartbeat and re-arm the timer when a row matched.
     *
     * @param sessionId - the owning session.
     * @param id - the heartbeat identity.
     * @returns the cancelled row, or `undefined` when nothing matched.
     */
    delete(sessionId: string, id: string): HeartbeatJob | undefined;
    /**
     * Cancel every live heartbeat of one session, for session teardown.
     *
     * @param sessionId - the owning session.
     * @returns the rows that were still live.
     */
    cancelSession(sessionId: string): HeartbeatJob[];
    /** Re-arm the timer from the persisted table. */
    wake(): void;
    /** Deliver every beat due right now, then re-arm the timer. */
    runDue(): void;
    private now;
    private clearTimer;
    private deliver;
}
/**
 * Project one persisted row onto its wire shape.
 *
 * @param job - the persisted row.
 * @returns the snake_case reply row, with `null` for absent fields.
 */
export declare function heartbeatWireRow(job: HeartbeatJob): HeartbeatWireRow;
/** The controller slice the host handlers drive; {@link HeartbeatScheduler} satisfies it. */
export interface HeartbeatController {
    /** List one session's heartbeats. */
    list(sessionId: string, options?: {
        includeInactive?: boolean;
    }): HeartbeatJob[];
    /** Create one heartbeat. */
    create(input: CreateHeartbeatInput): HeartbeatJob;
    /** Update one heartbeat. */
    update(sessionId: string, id: string, update: UpdateHeartbeatInput): HeartbeatJob | undefined;
    /** Cancel one heartbeat. */
    delete(sessionId: string, id: string): HeartbeatJob | undefined;
}
/** Everything the heartbeat host handlers need from the composition. */
export interface HeartbeatBindingDeps {
    /** The heartbeat controller. */
    readonly heartbeats: HeartbeatController;
}
/**
 * Assemble the four host handlers answering the `rlm_heartbeat.*` requests.
 * Validation messages match the reference host verbatim, because the kernel
 * turns a thrown handler into the error reply the model reads.
 *
 * @param deps - the composition services captured at load.
 * @returns the handler map to register on `ctx.rlmKernel`.
 */
export declare function createHeartbeatHostHandlers(deps: HeartbeatBindingDeps): RlmHostRequestHandlers;
//# sourceMappingURL=heartbeat.d.ts.map