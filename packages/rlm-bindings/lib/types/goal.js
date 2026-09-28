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
import { ok } from "./read.js";
/** Largest accepted objective length, in Unicode code points. */
const MAX_GOAL_OBJECTIVE_CHARS = 4000;
/** Map one substrate phase onto the skill's status vocabulary. */
function wireStatus(view) {
    switch (view.phase) {
        case 'active':
            return 'active';
        case 'paused':
            return 'paused';
        case 'complete':
            return 'complete';
        case 'blocked':
            return view.blockedReason?.code === 'round-limit' ? 'budget_limited' : 'paused';
    }
}
/** Serialize one live view into the skill's snake_case goal shape. */
function serializeGoal(view) {
    return {
        goal_id: view.id,
        objective: view.objective,
        status: wireStatus(view),
        tokens_used: 0,
        time_used_seconds: 0,
        created_at: view.createdAt,
        updated_at: view.updatedAt,
    };
}
/** Build the wire reply for one current view, or the empty reply without one. */
function goalHostResult(view, includeCompletionReport) {
    if (view === undefined) {
        return { goal: null, remaining_tokens: null, completion_budget_report: null };
    }
    return {
        goal: serializeGoal(view),
        remaining_tokens: null,
        completion_budget_report: includeCompletionReport && view.phase === 'complete'
            ? `Goal achieved. Report final budget usage to the user: goal rounds used: ${view.roundsStarted} of ${view.maxGoalRounds}.`
            : null,
    };
}
/** Read the required `objective` member of a `goal.create` payload. */
function objectiveField(data) {
    const value = data['objective'];
    if (typeof value !== 'string')
        throw new Error('goal.create objective must be a string');
    return value;
}
/** Read the optional `token_budget` member of a `goal.create` payload. */
function tokenBudgetField(data) {
    const value = data['token_budget'];
    if (value === undefined)
        return undefined;
    if (typeof value !== 'number')
        throw new Error('goal.create token_budget must be an integer when provided');
    return value;
}
/** Trim and bound one objective, mirroring the reference host's messages. */
function validateObjective(value) {
    const objective = value.trim();
    if (objective.length === 0)
        throw new Error('Goal objective must not be empty.');
    if (Array.from(objective).length > MAX_GOAL_OBJECTIVE_CHARS) {
        throw new Error(`Goal objective must be at most ${MAX_GOAL_OBJECTIVE_CHARS} characters.`);
    }
    return objective;
}
/** Check one requested token budget, mirroring the reference host's message. */
function validateTokenBudget(value) {
    if (value === undefined)
        return;
    if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
        throw new Error('Goal token budget must be a positive integer.');
    }
}
/** Reject a create while a non-terminal goal is still pending. */
function assertNoPendingGoal(view) {
    if (view === undefined || view.phase === 'complete')
        return;
    switch (wireStatus(view)) {
        case 'active':
            throw new Error('cannot create a new goal because this thread already has an active goal;'
                + ' run `await goal.complete()` when it is achieved, or ask the user to clear it with /goal clear');
        case 'paused':
            throw new Error('cannot create a new goal because a paused goal exists;'
                + ' ask the user to resume it with /goal resume or clear it with /goal clear');
        default:
            throw new Error('cannot create a new goal because a budget-limited goal exists;'
                + ' ask the user to resume it with /goal resume or clear it with /goal clear');
    }
}
/**
 * Mount the three `goal.*` host handlers of the kernel-side goal skill.
 *
 * @param deps - the composition services the handlers drive.
 * @returns handlers keyed by wire type, for `registerHostRequestHandlers`.
 */
export function createGoalHostHandlers(deps) {
    return {
        'goal.get': (_request, context) => Promise.resolve(ok(goalHostResult(deps.goals.get(context.agent), false))),
        'goal.create': (request, context) => {
            const rawObjective = objectiveField(request.data);
            const tokenBudget = tokenBudgetField(request.data);
            assertNoPendingGoal(deps.goals.get(context.agent));
            const objective = validateObjective(rawObjective);
            // Contract parity only: the substrate budgets in rounds, so a validated
            // token budget is accepted but not enforced.
            validateTokenBudget(tokenBudget);
            const view = deps.goals.create(context.agent, { objective });
            return Promise.resolve(ok(goalHostResult(view, false)));
        },
        'goal.complete': (_request, context) => {
            const view = deps.goals.get(context.agent);
            if (view === undefined)
                throw new Error('cannot complete goal because this thread has no goal');
            // The reference host completes an already-complete goal idempotently;
            // the substrate rejects a second complete transition, so an
            // already-complete goal is answered from the current view.
            const completed = view.phase === 'complete'
                ? view
                : deps.goals.complete(context.agent, { id: view.id, revision: view.revision });
            return Promise.resolve(ok(goalHostResult(completed, true)));
        },
    };
}
//# sourceMappingURL=goal.js.map