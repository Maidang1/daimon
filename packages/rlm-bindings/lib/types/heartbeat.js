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
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { isRecord, ok, stringField } from "./read.js";
/** Schedule a heartbeat falls back to when the request names no interval. */
export const DEFAULT_HEARTBEAT_SCHEDULE = 'every 5m';
/** Delivery mode a heartbeat falls back to when the request names none. */
export const DEFAULT_HEARTBEAT_DELIVERY_MODE = 'steer';
/** Shortest recurring interval the schedule parser accepts. */
export const MIN_HEARTBEAT_INTERVAL_MS = 10_000;
const ONE_SECOND_MS = 1000;
const ONE_MINUTE_MS = 60_000;
/** Largest delay a Node timer represents without clamping. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;
/** Strip one layer of matching quotes around a schedule text. */
function stripMatchingQuotes(value) {
    if (value.length >= 2
        && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\'')))) {
        return value.slice(1, -1);
    }
    return value;
}
/** Expand the cron aliases the schedule parser accepts. */
function normalizeCronAlias(text) {
    switch (text) {
        case '@hourly':
            return '0 * * * *';
        case '@daily':
            return '0 0 * * *';
        case '@weekly':
            return '0 0 * * 0';
        case '@monthly':
            return '0 0 1 * *';
        default:
            return text;
    }
}
/** Parse one bounded cron number. */
function parseCronNumber(value, min, max) {
    if (!/^\d+$/.test(value)) {
        throw new Error(`Invalid cron number: ${value}`);
    }
    const parsed = Number.parseInt(value, 10);
    if (parsed < min || parsed > max) {
        throw new Error(`Cron number out of range: ${value}`);
    }
    return parsed;
}
/** Parse one cron field into the set of matching values. */
function parseCronField(field, min, max) {
    const values = new Set();
    for (const part of field.split(',')) {
        if (!part) {
            throw new Error(`Invalid cron field: ${field}`);
        }
        const slash = part.indexOf('/');
        const rangeText = slash === -1 ? part : part.slice(0, slash);
        const step = slash === -1 ? 1 : parseCronNumber(part.slice(slash + 1), 1, max);
        let start;
        let end;
        if (rangeText === '*') {
            start = min;
            end = max;
        }
        else if (rangeText.includes('-')) {
            const dash = rangeText.indexOf('-');
            const tail = rangeText.slice(dash + 1);
            const secondDash = tail.indexOf('-');
            start = parseCronNumber(rangeText.slice(0, dash), min, max);
            end = parseCronNumber(secondDash === -1 ? tail : tail.slice(0, secondDash), min, max);
            if (start > end) {
                throw new Error(`Invalid cron range: ${rangeText}`);
            }
        }
        else {
            start = parseCronNumber(rangeText, min, max);
            end = start;
        }
        for (let value = start; value <= end; value += step) {
            values.add(value);
        }
    }
    return values;
}
/** Parse a five-field cron expression. */
function parseCronExpression(expression) {
    const parts = expression.trim().split(/\s+/);
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
    if (parts.length !== 5
        || minute === undefined
        || hour === undefined
        || dayOfMonth === undefined
        || month === undefined
        || dayOfWeek === undefined) {
        throw new Error("Unsupported cron schedule. Use 'in 10m', 'at <ISO date>', @hourly, or five fields: minute hour day month weekday");
    }
    return {
        minute: parseCronField(minute, 0, 59),
        hour: parseCronField(hour, 0, 23),
        dayOfMonth: parseCronField(dayOfMonth, 1, 31),
        month: parseCronField(month, 1, 12),
        dayOfWeek: parseCronField(dayOfWeek, 0, 7),
    };
}
/** Whether one local-time instant matches every cron field. */
function matchesCronFields(date, fields) {
    const day = date.getDay();
    return (fields.minute.has(date.getMinutes())
        && fields.hour.has(date.getHours())
        && fields.dayOfMonth.has(date.getDate())
        && fields.month.has(date.getMonth() + 1)
        && (fields.dayOfWeek.has(day) || (day === 0 && fields.dayOfWeek.has(7))));
}
/** First local-time instant after `after` matching the cron expression. */
function nextCronRunAfter(expression, after) {
    const fields = parseCronExpression(expression);
    const candidate = new Date(after.getTime());
    candidate.setSeconds(0, 0);
    candidate.setMinutes(candidate.getMinutes() + 1);
    const deadline = candidate.getTime() + 366 * 24 * 60 * ONE_MINUTE_MS;
    while (candidate.getTime() <= deadline) {
        if (matchesCronFields(candidate, fields)) {
            return candidate;
        }
        candidate.setMinutes(candidate.getMinutes() + 1);
    }
    throw new Error(`Cron schedule did not match within one year: ${expression}`);
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
export function parseHeartbeatSchedule(input, now = new Date()) {
    const text = stripMatchingQuotes(input.trim());
    if (!text) {
        throw new Error('Cron schedule cannot be empty');
    }
    const inMatch = /^in\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i.exec(text);
    if (inMatch) {
        const amount = Number.parseInt(String(inMatch[1]), 10);
        const unit = String(inMatch[2]).toLowerCase();
        const multiplier = unit.startsWith('m') ? ONE_MINUTE_MS : unit.startsWith('h') ? 60 * ONE_MINUTE_MS : 24 * 60 * ONE_MINUTE_MS;
        return {
            schedule: { kind: 'once', expression: text },
            nextRunAt: new Date(now.getTime() + amount * multiplier),
        };
    }
    const everyMatch = /^(?:every|each)\s+(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/i.exec(text);
    if (everyMatch) {
        const amount = Number.parseInt(String(everyMatch[1]), 10);
        const unit = String(everyMatch[2]).toLowerCase();
        const multiplier = unit.startsWith('s') ? ONE_SECOND_MS : unit.startsWith('m') ? ONE_MINUTE_MS : 60 * ONE_MINUTE_MS;
        const intervalMs = amount * multiplier;
        if (intervalMs < MIN_HEARTBEAT_INTERVAL_MS) {
            throw new Error('Recurring interval must be at least 10 seconds');
        }
        return {
            schedule: { kind: 'interval', expression: text, intervalMs },
            nextRunAt: new Date(now.getTime() + intervalMs),
        };
    }
    if (text.toLowerCase().startsWith('at ')) {
        const when = new Date(text.slice(3).trim());
        if (!Number.isFinite(when.getTime())) {
            throw new Error('Invalid one-shot schedule. Use: at <ISO date>');
        }
        if (when.getTime() <= now.getTime()) {
            throw new Error('One-shot schedule must be in the future');
        }
        return { schedule: { kind: 'once', expression: text }, nextRunAt: when };
    }
    const expression = normalizeCronAlias(text);
    return { schedule: { kind: 'cron', expression }, nextRunAt: nextCronRunAfter(expression, now) };
}
/**
 * Normalize a requested interval into schedule text: a missing interval falls
 * back to the default, and a bare `5m`-style duration gains the `every` prefix.
 *
 * @param input - the requested interval, or `undefined`.
 * @returns the schedule text to parse.
 */
export function normalizeHeartbeatSchedule(input) {
    const text = input?.trim();
    if (!text) {
        return DEFAULT_HEARTBEAT_SCHEDULE;
    }
    if (/^\d+\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/i.test(text)) {
        return `every ${text}`;
    }
    return text;
}
/**
 * Normalize a requested delivery mode, rejecting anything outside the vocabulary.
 *
 * @param value - the raw `delivery_mode` payload member.
 * @returns the delivery mode, or `undefined` when none was given.
 */
export function normalizeHeartbeatDeliveryMode(value) {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (value === 'steer' || value === 'follow_up') {
        return value;
    }
    throw new Error('Heartbeat delivery mode must be "steer" or "follow_up"');
}
/**
 * Compute the next run of a recurring schedule after one instant.
 *
 * @param schedule - the recurring schedule.
 * @param after - the instant to start from.
 * @returns the next run.
 */
export function nextRunAtForSchedule(schedule, after) {
    if (schedule.kind === 'interval') {
        return new Date(after.getTime() + schedule.intervalMs);
    }
    return nextCronRunAfter(schedule.expression, after);
}
/** Sort key ordering absent next-runs last; ISO texts compare chronologically. */
function nextRunAtSortKey(job) {
    return job.nextRunAt ?? '\uffff';
}
/** Render an unknown thrown value for the persisted last-error field. */
function renderThrown(value) {
    return value instanceof Error ? value.message : String(value);
}
/** Drop the next-run field of one job. */
function withoutNextRunAt(job) {
    const { nextRunAt: _nextRunAt, ...rest } = job;
    return rest;
}
/** Drop the label field of one job. */
function withoutLabel(job) {
    const { label: _label, ...rest } = job;
    return rest;
}
/** Rebuild one persisted schedule value, or `undefined` when it is malformed. */
function rebuildSchedule(value) {
    if (!isRecord(value))
        return undefined;
    const expression = value['expression'];
    if (typeof expression !== 'string')
        return undefined;
    if (value['kind'] === 'interval') {
        const intervalMs = value['intervalMs'];
        if (typeof intervalMs !== 'number' || !Number.isSafeInteger(intervalMs) || intervalMs <= 0)
            return undefined;
        return { kind: 'interval', expression, intervalMs };
    }
    if (value['kind'] === 'cron') {
        return { kind: 'cron', expression };
    }
    return undefined;
}
/** Rebuild one persisted job row, or `undefined` when it is malformed. */
function rebuildJob(value) {
    if (!isRecord(value))
        return undefined;
    const id = value['id'];
    const sessionId = value['sessionId'];
    const status = value['status'];
    const deliveryMode = value['deliveryMode'];
    const instruction = value['instruction'];
    const createdAt = value['createdAt'];
    const updatedAt = value['updatedAt'];
    const runCount = value['runCount'];
    const label = value['label'];
    const nextRunAt = value['nextRunAt'];
    const lastRunAt = value['lastRunAt'];
    const lastError = value['lastError'];
    if (typeof id !== 'string' || typeof sessionId !== 'string')
        return undefined;
    if (status !== 'active' && status !== 'paused' && status !== 'cancelled')
        return undefined;
    if (deliveryMode !== 'steer' && deliveryMode !== 'follow_up')
        return undefined;
    if (typeof instruction !== 'string' || typeof createdAt !== 'string' || typeof updatedAt !== 'string')
        return undefined;
    if (typeof runCount !== 'number' || !Number.isSafeInteger(runCount))
        return undefined;
    if (label !== undefined && typeof label !== 'string')
        return undefined;
    if (nextRunAt !== undefined && typeof nextRunAt !== 'string')
        return undefined;
    if (lastRunAt !== undefined && typeof lastRunAt !== 'string')
        return undefined;
    if (lastError !== undefined && typeof lastError !== 'string')
        return undefined;
    const schedule = rebuildSchedule(value['schedule']);
    if (schedule === undefined)
        return undefined;
    return {
        id,
        sessionId,
        status,
        deliveryMode,
        instruction,
        schedule,
        createdAt,
        updatedAt,
        runCount,
        ...(label === undefined ? {} : { label }),
        ...(nextRunAt === undefined ? {} : { nextRunAt }),
        ...(lastRunAt === undefined ? {} : { lastRunAt }),
        ...(lastError === undefined ? {} : { lastError }),
    };
}
/**
 * The persistent heartbeat table: one JSON file holding every session's rows.
 * Each operation re-reads the file so concurrent mutations never ride on a
 * stale in-memory copy, and writes go through a rename so a crash mid-write
 * cannot truncate the store.
 */
export class HeartbeatStore {
    filePath;
    /**
     * Open the store at one file path; the file is created on the first write.
     *
     * @param filePath - absolute path of the JSON store file.
     */
    constructor(filePath) {
        this.filePath = filePath;
    }
    /**
     * List one session's heartbeats, soonest next run first, paused and cancelled last.
     *
     * @param sessionId - the owning session.
     * @param options - pass `includeInactive` to keep cancelled rows.
     * @returns the matching rows.
     */
    list(sessionId, options = {}) {
        return this.readJobs()
            .filter(job => job.sessionId === sessionId && (options.includeInactive === true || job.status !== 'cancelled'))
            .sort((left, right) => nextRunAtSortKey(left).localeCompare(nextRunAtSortKey(right)));
    }
    /**
     * Create one active heartbeat. One-shot schedules and empty instructions
     * are rejected with the reference host's messages.
     *
     * @param input - the creation fields.
     * @returns the persisted row.
     */
    create(input) {
        const now = input.now ?? new Date();
        const parsed = parseHeartbeatSchedule(normalizeHeartbeatSchedule(input.interval), now);
        if (parsed.schedule.kind === 'once') {
            throw new Error('RLM heartbeat schedule must be recurring');
        }
        const instruction = input.instruction.trim();
        if (!instruction) {
            throw new Error('RLM heartbeat instruction cannot be empty');
        }
        const label = input.label?.trim();
        const nowIso = now.toISOString();
        const job = {
            id: randomUUID(),
            sessionId: input.sessionId,
            status: 'active',
            deliveryMode: input.deliveryMode ?? DEFAULT_HEARTBEAT_DELIVERY_MODE,
            instruction,
            schedule: parsed.schedule,
            createdAt: nowIso,
            updatedAt: nowIso,
            nextRunAt: parsed.nextRunAt.toISOString(),
            runCount: 0,
            ...(label === undefined || label === '' ? {} : { label }),
        };
        this.writeJobs([...this.readJobs(), job]);
        return job;
    }
    /**
     * Update one of a session's heartbeats. A cancelled row matches but no
     * longer updates, and an unknown id matches nothing; both return `undefined`.
     *
     * @param sessionId - the owning session.
     * @param id - the heartbeat identity.
     * @param update - the fields to change.
     * @returns the updated row, or `undefined`.
     */
    update(sessionId, id, update) {
        const now = update.now ?? new Date();
        let updated;
        const jobs = this.readJobs().map((job) => {
            if (job.id !== id || job.sessionId !== sessionId)
                return job;
            if (job.status === 'cancelled')
                return job;
            let next = { ...job };
            if (update.label !== undefined) {
                const label = update.label.trim();
                next = label === '' ? withoutLabel(next) : { ...next, label };
            }
            if (update.deliveryMode !== undefined) {
                next = { ...next, deliveryMode: update.deliveryMode };
            }
            if (update.instruction !== undefined) {
                const instruction = update.instruction.trim();
                if (!instruction) {
                    throw new Error('RLM heartbeat instruction cannot be empty');
                }
                next = { ...next, instruction };
            }
            if (update.interval !== undefined) {
                const parsed = parseHeartbeatSchedule(normalizeHeartbeatSchedule(update.interval), now);
                if (parsed.schedule.kind === 'once') {
                    throw new Error('RLM heartbeat schedule must be recurring');
                }
                next = next.status === 'paused'
                    ? withoutNextRunAt({ ...next, schedule: parsed.schedule })
                    : { ...next, schedule: parsed.schedule, nextRunAt: parsed.nextRunAt.toISOString() };
            }
            if (update.status === 'pause') {
                next = withoutNextRunAt({ ...next, status: 'paused' });
            }
            else if (update.status === 'resume') {
                next = { ...next, status: 'active', nextRunAt: nextRunAtForSchedule(next.schedule, now).toISOString() };
            }
            updated = { ...next, updatedAt: now.toISOString() };
            return updated;
        });
        if (updated !== undefined) {
            this.writeJobs(jobs);
        }
        return updated;
    }
    /**
     * Cancel one of a session's heartbeats, keeping the row for `include_inactive`.
     *
     * @param sessionId - the owning session.
     * @param id - the heartbeat identity.
     * @param now - the cancellation time.
     * @returns the cancelled row, or `undefined` when nothing matched.
     */
    delete(sessionId, id, now = new Date()) {
        let deleted;
        const jobs = this.readJobs().map((job) => {
            if (job.id !== id || job.sessionId !== sessionId)
                return job;
            deleted = withoutNextRunAt({ ...job, status: 'cancelled', updatedAt: now.toISOString() });
            return deleted;
        });
        if (deleted !== undefined) {
            this.writeJobs(jobs);
        }
        return deleted;
    }
    /**
     * Cancel every live heartbeat of one session, for session teardown.
     *
     * @param sessionId - the owning session.
     * @param now - the cancellation time.
     * @returns the rows that were still live.
     */
    cancelSession(sessionId, now = new Date()) {
        const cancelled = [];
        const jobs = this.readJobs().map((job) => {
            if (job.sessionId !== sessionId || job.status === 'cancelled')
                return job;
            const next = withoutNextRunAt({ ...job, status: 'cancelled', updatedAt: now.toISOString() });
            cancelled.push(next);
            return next;
        });
        if (cancelled.length > 0) {
            this.writeJobs(jobs);
        }
        return cancelled;
    }
    /**
     * The earliest due time of any active heartbeat, across every session.
     *
     * @returns the epoch milliseconds of the next run, or `undefined` when idle.
     */
    nextActiveRunAt() {
        let selected;
        for (const job of this.readJobs()) {
            if (job.status !== 'active' || job.nextRunAt === undefined)
                continue;
            const at = Date.parse(job.nextRunAt);
            if (selected === undefined || at < selected)
                selected = at;
        }
        return selected;
    }
    /**
     * Every active heartbeat due at one instant, soonest first.
     *
     * @param now - the instant to test against.
     * @returns the due rows.
     */
    dueJobs(now) {
        const time = now.getTime();
        return this.readJobs()
            .filter(job => job.status === 'active' && job.nextRunAt !== undefined && Date.parse(job.nextRunAt) <= time)
            .sort((left, right) => nextRunAtSortKey(left).localeCompare(nextRunAtSortKey(right)));
    }
    /**
     * Record one attempted delivery: the run count and last-run time always
     * advance, a failure lands in `lastError`, and a success clears it.
     *
     * @param id - the heartbeat identity.
     * @param result - the delivery outcome.
     * @returns the updated row, or `undefined` when the row is gone or no longer active.
     */
    recordRun(id, result) {
        const now = result.now ?? new Date();
        let updated;
        const jobs = this.readJobs().map((job) => {
            if (job.id !== id || job.status !== 'active')
                return job;
            const { lastError: _lastError, ...rest } = job;
            updated = {
                ...rest,
                lastRunAt: now.toISOString(),
                runCount: job.runCount + 1,
                nextRunAt: nextRunAtForSchedule(job.schedule, now).toISOString(),
                updatedAt: now.toISOString(),
                ...(result.error === undefined ? {} : { lastError: renderThrown(result.error) }),
            };
            return updated;
        });
        if (updated !== undefined) {
            this.writeJobs(jobs);
        }
        return updated;
    }
    /**
     * Record one skipped beat: the schedule advances and the reason lands in
     * `lastError`, but the run count and last-run time stay untouched.
     *
     * @param id - the heartbeat identity.
     * @param error - why the beat was skipped.
     * @param now - the skip time.
     * @returns the updated row, or `undefined` when the row is gone or no longer active.
     */
    recordSkip(id, error, now = new Date()) {
        let updated;
        const jobs = this.readJobs().map((job) => {
            if (job.id !== id || job.status !== 'active')
                return job;
            updated = {
                ...job,
                nextRunAt: nextRunAtForSchedule(job.schedule, now).toISOString(),
                lastError: error,
                updatedAt: now.toISOString(),
            };
            return updated;
        });
        if (updated !== undefined) {
            this.writeJobs(jobs);
        }
        return updated;
    }
    readJobs() {
        if (!existsSync(this.filePath))
            return [];
        let parsed;
        try {
            parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
        }
        catch {
            throw new Error(`RLM heartbeat store at ${JSON.stringify(this.filePath)} is corrupt`);
        }
        if (!isRecord(parsed)) {
            throw new Error(`RLM heartbeat store at ${JSON.stringify(this.filePath)} is corrupt`);
        }
        const raw = parsed['jobs'];
        if (!Array.isArray(raw)) {
            throw new Error(`RLM heartbeat store at ${JSON.stringify(this.filePath)} is corrupt`);
        }
        const entries = raw;
        const jobs = [];
        for (const entry of entries) {
            const job = rebuildJob(entry);
            if (job === undefined) {
                throw new Error(`RLM heartbeat store at ${JSON.stringify(this.filePath)} is corrupt`);
            }
            jobs.push(job);
        }
        return jobs;
    }
    writeJobs(jobs) {
        mkdirSync(dirname(this.filePath), { recursive: true });
        const temporary = `${this.filePath}.tmp`;
        writeFileSync(temporary, JSON.stringify({ jobs }), 'utf8');
        renameSync(temporary, this.filePath);
    }
}
/** Producer source stamped on every delivered heartbeat prompt. */
const HEARTBEAT_MESSAGE_SOURCE = { kind: 'rlm-heartbeat' };
/**
 * Format the model-facing text of one heartbeat beat.
 *
 * @param job - the heartbeat that is due.
 * @returns the header line plus the instruction.
 */
export function formatHeartbeatPrompt(job) {
    return `[heartbeat: ${job.schedule.expression} run#${job.runCount}]\n\n${job.instruction}`;
}
/**
 * Build the user message one due beat delivers into the owning session.
 *
 * @param job - the heartbeat that is due.
 * @returns the identified message to steer or queue.
 */
export function createHeartbeatMessage(job) {
    return createUserMessage({
        content: [{ type: 'text', text: formatHeartbeatPrompt(job) }],
        source: HEARTBEAT_MESSAGE_SOURCE,
    });
}
/**
 * The heartbeat controller behind the `rlm_heartbeat.*` host requests:
 * CRUD against the store plus one re-armed timer that delivers due beats.
 * Mutations wake the timer, and every fire re-arms it from the persisted
 * table, so the file stays the single source of truth.
 */
export class HeartbeatScheduler {
    deps;
    timer;
    disposed = false;
    /**
     * Create the scheduler; {@link start} arms the first timer.
     *
     * @param deps - the composition services captured at load.
     */
    constructor(deps) {
        this.deps = deps;
    }
    /** Arm the timer from the persisted table. */
    start() {
        this.wake();
    }
    /** Stop future deliveries and cancel the armed timer. */
    dispose() {
        this.disposed = true;
        this.clearTimer();
    }
    /**
     * List one session's heartbeats.
     *
     * @param sessionId - the owning session.
     * @param options - pass `includeInactive` to keep cancelled rows.
     * @returns the matching rows.
     */
    list(sessionId, options) {
        return this.deps.store.list(sessionId, options);
    }
    /**
     * Create one heartbeat and re-arm the timer.
     *
     * @param input - the creation fields, minus the clock.
     * @returns the persisted row.
     */
    create(input) {
        const job = this.deps.store.create({ ...input, now: this.now() });
        this.wake();
        return job;
    }
    /**
     * Update one heartbeat and re-arm the timer when a live row changed.
     *
     * @param sessionId - the owning session.
     * @param id - the heartbeat identity.
     * @param update - the fields to change, minus the clock.
     * @returns the updated row, or `undefined`.
     */
    update(sessionId, id, update) {
        const job = this.deps.store.update(sessionId, id, { ...update, now: this.now() });
        if (job !== undefined)
            this.wake();
        return job;
    }
    /**
     * Cancel one heartbeat and re-arm the timer when a row matched.
     *
     * @param sessionId - the owning session.
     * @param id - the heartbeat identity.
     * @returns the cancelled row, or `undefined` when nothing matched.
     */
    delete(sessionId, id) {
        const job = this.deps.store.delete(sessionId, id, this.now());
        if (job !== undefined)
            this.wake();
        return job;
    }
    /**
     * Cancel every live heartbeat of one session, for session teardown.
     *
     * @param sessionId - the owning session.
     * @returns the rows that were still live.
     */
    cancelSession(sessionId) {
        const jobs = this.deps.store.cancelSession(sessionId, this.now());
        if (jobs.length > 0)
            this.wake();
        return jobs;
    }
    /** Re-arm the timer from the persisted table. */
    wake() {
        if (this.disposed)
            return;
        this.clearTimer();
        let next;
        try {
            next = this.deps.store.nextActiveRunAt();
        }
        catch (error) {
            this.deps.onError?.(error);
            return;
        }
        if (next === undefined)
            return;
        const delay = Math.min(Math.max(0, next - this.now().getTime()), MAX_TIMER_DELAY_MS);
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.runDue();
        }, delay);
    }
    /** Deliver every beat due right now, then re-arm the timer. */
    runDue() {
        try {
            for (const job of this.deps.store.dueJobs(this.now())) {
                this.deliver(job);
            }
        }
        catch (error) {
            this.deps.onError?.(error);
        }
        finally {
            this.wake();
        }
    }
    now() {
        return this.deps.now?.() ?? new Date();
    }
    clearTimer() {
        if (this.timer === undefined)
            return;
        clearTimeout(this.timer);
        this.timer = undefined;
    }
    deliver(job) {
        const target = this.deps.resolveAgent(job.sessionId);
        if (target === undefined) {
            this.deps.store.recordSkip(job.id, `RLM heartbeat target session ${JSON.stringify(job.sessionId)} is not live`, this.now());
            return;
        }
        const message = createHeartbeatMessage(job);
        let error;
        try {
            if (job.deliveryMode === 'follow_up') {
                target.followup(message);
            }
            else {
                target.steer(message);
            }
        }
        catch (thrown) {
            error = thrown;
        }
        this.deps.store.recordRun(job.id, { now: this.now(), ...(error === undefined ? {} : { error }) });
    }
}
/**
 * Project one persisted row onto its wire shape.
 *
 * @param job - the persisted row.
 * @returns the snake_case reply row, with `null` for absent fields.
 */
export function heartbeatWireRow(job) {
    return {
        id: job.id,
        status: job.status,
        label: job.label ?? null,
        delivery_mode: job.deliveryMode,
        instruction: job.instruction,
        schedule: job.schedule.kind === 'interval'
            ? { kind: job.schedule.kind, expression: job.schedule.expression, intervalMs: job.schedule.intervalMs }
            : { kind: job.schedule.kind, expression: job.schedule.expression },
        created_at: job.createdAt,
        updated_at: job.updatedAt,
        next_run_at: job.nextRunAt ?? null,
        last_run_at: job.lastRunAt ?? null,
        last_error: job.lastError ?? null,
        run_count: job.runCount,
    };
}
/** Read one optional string member of a request payload. */
function optionalStringField(data, key, message) {
    const value = data[key];
    if (value === undefined)
        return undefined;
    if (typeof value !== 'string')
        throw new Error(message);
    return value;
}
/** Read the `status` member of an update payload, restricted to pause or resume. */
function heartbeatStatusField(value) {
    if (value === undefined)
        return undefined;
    if (value === 'pause' || value === 'resume')
        return value;
    throw new Error('rlm_heartbeat.update status must be "pause" or "resume" when provided');
}
/**
 * Assemble the four host handlers answering the `rlm_heartbeat.*` requests.
 * Validation messages match the reference host verbatim, because the kernel
 * turns a thrown handler into the error reply the model reads.
 *
 * @param deps - the composition services captured at load.
 * @returns the handler map to register on `ctx.rlmKernel`.
 */
export function createHeartbeatHostHandlers(deps) {
    return {
        'rlm_heartbeat.list': (request, context) => {
            const includeInactive = request.data['include_inactive'] === true || request.data['includeInactive'] === true;
            return Promise.resolve(ok({
                heartbeats: deps.heartbeats.list(String(context.agent.id), { includeInactive }).map(heartbeatWireRow),
            }));
        },
        'rlm_heartbeat.create': (request, context) => {
            const instruction = stringField(request.data, 'instruction', 'rlm_heartbeat.create instruction must be a string');
            const interval = optionalStringField(request.data, 'interval', 'rlm_heartbeat.create interval must be a string when provided');
            const label = optionalStringField(request.data, 'label', 'rlm_heartbeat.create label must be a string when provided');
            const deliveryMode = normalizeHeartbeatDeliveryMode(request.data['delivery_mode'] ?? request.data['deliveryMode']);
            const heartbeat = deps.heartbeats.create({
                sessionId: String(context.agent.id),
                instruction,
                ...(interval === undefined ? {} : { interval }),
                ...(label === undefined ? {} : { label }),
                ...(deliveryMode === undefined ? {} : { deliveryMode }),
            });
            return Promise.resolve(ok({ heartbeat: heartbeatWireRow(heartbeat) }));
        },
        'rlm_heartbeat.update': (request, context) => {
            const id = stringField(request.data, 'id', 'rlm_heartbeat.update id must be a string');
            const instruction = optionalStringField(request.data, 'instruction', 'rlm_heartbeat.update instruction must be a string when provided');
            const interval = optionalStringField(request.data, 'interval', 'rlm_heartbeat.update interval must be a string when provided');
            const label = optionalStringField(request.data, 'label', 'rlm_heartbeat.update label must be a string when provided');
            const status = heartbeatStatusField(request.data['status']);
            const rawDeliveryMode = request.data['delivery_mode'] ?? request.data['deliveryMode'];
            const deliveryMode = normalizeHeartbeatDeliveryMode(rawDeliveryMode);
            if (instruction === undefined
                && interval === undefined
                && label === undefined
                && status === undefined
                && rawDeliveryMode === undefined) {
                throw new Error('rlm_heartbeat.update requires at least one field to update');
            }
            const heartbeat = deps.heartbeats.update(String(context.agent.id), id, {
                ...(instruction === undefined ? {} : { instruction }),
                ...(interval === undefined ? {} : { interval }),
                ...(label === undefined ? {} : { label }),
                ...(status === undefined ? {} : { status }),
                ...(deliveryMode === undefined ? {} : { deliveryMode }),
            });
            return Promise.resolve(ok({ heartbeat: heartbeat === undefined ? null : heartbeatWireRow(heartbeat) }));
        },
        'rlm_heartbeat.delete': (request, context) => {
            const id = stringField(request.data, 'id', 'rlm_heartbeat.delete id must be a string');
            const heartbeat = deps.heartbeats.delete(String(context.agent.id), id);
            return Promise.resolve(ok({ heartbeat: heartbeat === undefined ? null : heartbeatWireRow(heartbeat) }));
        },
    };
}
//# sourceMappingURL=heartbeat.js.map