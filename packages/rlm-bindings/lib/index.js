import { dirname, join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { SessionId } from "@deepseek-ai/dsh-session";
import { ReasoningEffortId, createUserMessage } from "@deepseek-ai/dsh-llm";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
//#region lib/types/bash.js
/**
* Background-command completion notices. A detached `bash()` job in the
* runtime ends out of band, so the bindings steer a one-line notice into the
* owning session — an idle driver starts a turn, a running one reads it at
* the next step boundary. When the kernel reads the result first, the notice
* is stale and is withdrawn from the inbox while it is still pending.
*
* @module @deepseek-ai/dsh-rlm-bindings/bash
*/
/** Producer source stamped on every completion notice. */
const BASH_NOTICE_SOURCE = { kind: "rlm-bindings" };
/**
* Format the model-facing text of one completion notice.
*
* @param details - the validated completion.
* @returns the one-line header plus the quoted command.
*/
function formatBashCompletionNotice(details) {
	return `[bash-done pid:${details.pid} exit:${details.exitCode}]\n\nCommand: ${JSON.stringify(details.command)}`;
}
/**
* Build the steered user message announcing one completion.
*
* @param details - the validated completion.
* @returns the identified message to steer into the owning session.
*/
function createBashCompletionMessage(details) {
	return createUserMessage({
		content: [{
			type: "text",
			text: formatBashCompletionNotice(details)
		}],
		source: BASH_NOTICE_SOURCE
	});
}
/**
* Pending completion notices per session, oldest first. One `bash.consumed`
* withdraws one notice: pids are reused across handles, and the read belongs
* to the older handle, which is the earlier notice.
*/
var BashNoticeBoard = class {
	pending = /* @__PURE__ */ new Map();
	/**
	* Record a steered notice so a later `bash.consumed` can withdraw it.
	*
	* @param agentId - the session the notice was steered into.
	* @param pid - process id of the finished command.
	* @param command - the command line that finished.
	* @param messageId - identity of the steered message.
	*/
	record(agentId, pid, command, messageId) {
		let list = this.pending.get(agentId);
		if (list === void 0) {
			list = [];
			this.pending.set(agentId, list);
		}
		list.push({
			pid,
			command,
			messageId
		});
	}
	/**
	* Withdraw the earliest notice matching one consumed result.
	*
	* @param agentId - the session the notice was steered into.
	* @param pid - process id of the consumed command.
	* @param command - the command line that was read.
	* @returns the steered message's identity, or `undefined` when nothing pending matches.
	*/
	takeEarliest(agentId, pid, command) {
		const list = this.pending.get(agentId);
		if (list === void 0) return void 0;
		const notice = list.find((candidate) => candidate.pid === pid && candidate.command === command);
		if (notice === void 0) return void 0;
		list.splice(list.indexOf(notice), 1);
		if (list.length === 0) this.pending.delete(agentId);
		return notice.messageId;
	}
};
/** Largest `timeout_ms` one `rlm.collect` call accepts. */
const MAX_COLLECT_TIMEOUT_MS = 2147483647;
/**
* Wrap one handler result as the success reply the runtime unwraps.
*
* @param result - the reply payload the requesting cell receives.
* @returns the `ok` reply frame for the kernel.
*/
function ok(result) {
	return {
		status: "ok",
		result
	};
}
/**
* True for a plain object payload member, never for an array or `null`.
*
* @param value - the payload member under test.
* @returns whether the member is a string-keyed record.
*/
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
* Read one required string member of a request payload.
*
* @param data - the `host_request` payload.
* @param key - the member to read.
* @param message - the error message a non-string member raises.
* @returns the member's string value.
*/
function stringField(data, key, message) {
	const value = data[key];
	if (typeof value !== "string") throw new Error(message);
	return value;
}
/**
* Read the `kwargs` member of a spawn-style payload, tolerating a missing or
* malformed member as no kwargs at all.
*
* @param data - the `host_request` payload.
* @returns the kwargs record, or an empty one.
*/
function kwargsField(data) {
	const value = data["kwargs"];
	return isRecord(value) ? value : {};
}
/**
* Normalize a requested child session name, or `undefined` when omitted.
*
* @param value - the raw `name` kwarg.
* @param operation - the wire type the error messages name.
* @returns the trimmed name.
*/
function normalizeRequestedName(value, operation) {
	if (value === void 0) return void 0;
	if (typeof value !== "string") throw new Error(`${operation} name must be a string`);
	const name = value.trim();
	if (name.length === 0) throw new Error(`${operation} name must not be empty`);
	if (name.length > 64) throw new Error(`${operation} name must be at most 64 characters`);
	return name;
}
/**
* Normalize a requested `provider/model` selector, or `undefined` when omitted.
*
* @param value - the raw `model` kwarg.
* @param operation - the wire type the error messages name.
* @returns the trimmed selector.
*/
function normalizeRequestedModel(value, operation) {
	if (value === void 0) return void 0;
	if (typeof value !== "string") throw new Error(`${operation} model must be a string`);
	const model = value.trim();
	if (model.length === 0) throw new Error(`${operation} model must not be empty`);
	return model;
}
/**
* Normalize a requested reasoning effort, or `undefined` when omitted. The
* effort vocabulary is adapter-owned, so the bindings check only the shape.
*
* @param value - the raw `thinking` kwarg.
* @param operation - the wire type the error messages name.
* @returns the trimmed effort id.
*/
function normalizeRequestedThinking(value, operation) {
	if (value === void 0) return void 0;
	if (typeof value !== "string") throw new Error(`${operation} thinking must be a string`);
	const thinking = value.trim();
	if (thinking.length === 0) throw new Error(`${operation} thinking must not be empty`);
	return thinking;
}
/**
* Split a normalized `provider/model` selector into its route parts.
*
* @param selector - the normalized selector.
* @param operation - the wire type the error message names.
* @returns the provider route and the model id.
*/
function splitModelSelector(selector, operation) {
	const slash = selector.indexOf("/");
	if (slash <= 0 || slash === selector.length - 1) throw new Error(`${operation} model must use the form "provider/model-id"`);
	return {
		provider: selector.slice(0, slash),
		model: selector.slice(slash + 1)
	};
}
/**
* Create a readable, collision-resistant default child name from the initial
* prompt and the minted child id.
*
* @param prompt - the child's initial prompt.
* @param childId - the minted child session id.
* @returns a name unique enough to select the child by.
*/
function createDefaultChildName(prompt, childId) {
	const promptSlug = prompt.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	const idSuffix = childId.replace(/[^A-Za-z0-9]+/g, "").slice(-8) || "child";
	const fixedLength = 10 + idSuffix.length;
	return `subagent-${(promptSlug || "worker").slice(0, Math.max(1, 64 - fixedLength)).replace(/-+$/g, "")}-${idSuffix}`;
}
/**
* Collapse one text to a single line capped at `maxLength` characters, for
* answer previews and labels carried into roster rows.
*
* @param text - the source text.
* @param maxLength - the cap, in UTF-16 code units.
* @returns the compacted text, ellipsized when capped.
*/
function compactRlmText(text, maxLength = 160) {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= maxLength) return compact;
	return `${compact.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}
/**
* Collapse a child's initial prompt to its one-line roster label, keeping the
* full length so a client can elide shared prefixes itself.
*
* @param prompt - the child's initial prompt.
* @returns the one-line label.
*/
function rlmChildLabel(prompt) {
	return prompt.replace(/\s+/g, " ").trim() || "child agent";
}
/**
* Read the arguments of one `rlm.find_models` payload.
*
* @param data - the `host_request` payload.
* @returns the validated query and limit.
*/
function findModelsRequest(data) {
	const query = stringField(data, "query", "rlm.find_models query must be a string");
	const raw = data["limit"];
	const limit = raw === void 0 ? 8 : raw;
	if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error(`rlm.find_models limit must be an integer from 1 to 20`);
	return {
		query,
		limit
	};
}
/**
* Read and normalize the `targets` member of one `rlm.collect` payload.
*
* @param data - the `host_request` payload.
* @returns the trimmed target selectors, empty when omitted.
*/
function collectTargetsField(data) {
	const raw = data["targets"];
	if (raw === void 0 || raw === null) return [];
	if (!Array.isArray(raw)) throw new Error("rlm.collect targets must be an array of child ids or names");
	return raw.map((target) => {
		if (typeof target !== "string" || target.trim().length === 0) throw new Error("rlm.collect targets must be non-empty strings");
		return target.trim();
	});
}
/**
* Read the `timeout_ms` member of one `rlm.collect` payload.
*
* @param data - the `host_request` payload.
* @returns the bounded wait in milliseconds, `0` when omitted.
*/
function collectTimeoutField(data) {
	const raw = data["timeout_ms"];
	if (raw === void 0 || raw === null) return 0;
	if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0 || raw > MAX_COLLECT_TIMEOUT_MS) throw new Error(`rlm.collect timeout_ms must be a non-negative integer up to ${MAX_COLLECT_TIMEOUT_MS}`);
	return raw;
}
/**
* Read and normalize the `message` member of one `rlm.progress.note` payload.
*
* @param data - the `host_request` payload.
* @returns the trimmed progress note.
*/
function progressNoteMessage(data) {
	const raw = data["message"];
	if (typeof raw !== "string" || raw.trim().length === 0) throw new Error("rlm.progress.note message must be a non-empty string");
	const message = raw.trim();
	if (message.length > 512) throw new Error(`rlm.progress.note message must be at most 512 characters`);
	return message;
}
/**
* Read and normalize the `target` member of one `rlm.delete_subagent` payload.
*
* @param data - the `host_request` payload.
* @returns the trimmed target selector.
*/
function deleteTargetField(data) {
	const raw = data["target"];
	if (typeof raw !== "string" || raw.trim().length === 0) throw new Error("rlm.delete_subagent target must be a non-empty string");
	return raw.trim();
}
/**
* Read one `bash.completed` notification payload.
*
* @param data - the `host_request` payload.
* @returns the validated completion.
*/
function bashCompletionField(data) {
	const pid = data["pid"];
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) throw new Error("bash.completed pid must be a positive integer");
	const command = data["command"];
	if (typeof command !== "string" || command.length === 0) throw new Error("bash.completed command must be a non-empty string");
	const exitCode = data["exitCode"];
	if (typeof exitCode !== "number" || !Number.isInteger(exitCode)) throw new Error("bash.completed exitCode must be an integer");
	return {
		pid,
		command,
		exitCode
	};
}
/**
* Read one `bash.consumed` notification payload.
*
* @param data - the `host_request` payload.
* @returns the validated pid and command.
*/
function bashConsumedField(data) {
	const pid = data["pid"];
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) throw new Error("bash.consumed pid must be a positive integer");
	const command = data["command"];
	if (typeof command !== "string" || command.length === 0) throw new Error("bash.consumed command must be a non-empty string");
	return {
		pid,
		command
	};
}
//#endregion
//#region lib/types/compact.js
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
/**
* Compact one session each time a pending request survives to an idle phase.
* The requesting cell was already answered, so a failed attempt is swallowed
* here; it stays visible in the session log, matching the manual-compaction
* contract.
*/
async function drainPending(deps, state, key, agent, signal) {
	for (;;) {
		await agent.whenIdle();
		if (!state.pending.delete(key)) return;
		try {
			await deps.compaction.compactNow(agent, signal);
		} catch {}
	}
}
/** Answer `compact.run`: record the request; compaction fires at the next idle phase. */
function runCompact(deps, state, request, context) {
	const instructions = request.data["instructions"];
	if (instructions !== void 0 && typeof instructions !== "string") throw new Error("compact.run instructions must be a string when provided");
	const agent = context.agent;
	if (agent.status !== "running") return ok({
		scheduled: false,
		reason: "no active turn; compaction can only be requested while a turn is running"
	});
	const key = String(agent.id);
	state.pending.set(key, instructions);
	if (!state.draining.has(key)) {
		state.draining.add(key);
		const retire = () => {
			state.draining.delete(key);
		};
		drainPending(deps, state, key, agent, context.signal).then(retire, () => {
			state.pending.delete(key);
			retire();
		});
	}
	return ok({
		scheduled: true,
		note: "Compaction runs when the current turn ends; the summary replaces older history. Continue working normally."
	});
}
/** Read the current pressure, or null when the meter cannot measure. */
function measureTokens(deps, session) {
	try {
		return deps.usage.measure(session).totalTokens;
	} catch {
		return null;
	}
}
/** Resolve the usable context window of the calling agent's route, or null when unknown. */
async function resolveContextWindow(deps, agent, signal) {
	const provider = agent.options.provider;
	const model = agent.options.model;
	if (provider === void 0 || model === void 0) return null;
	try {
		const window = (await deps.models.resolveModelInfo(provider, model, signal)).context?.contextWindow;
		return window !== void 0 && window > 0 ? window : null;
	} catch {
		return null;
	}
}
/** Answer `compact.status` with the reference host's field shape. */
async function runCompactStatus(deps, state, context) {
	const tokens = measureTokens(deps, context.agent.session);
	const contextWindow = await resolveContextWindow(deps, context.agent, context.signal);
	return ok({
		tokens,
		context_window: contextWindow,
		percent: tokens !== null && contextWindow !== null ? tokens / contextWindow * 100 : null,
		scheduled: state.pending.has(String(context.agent.id))
	});
}
/**
* Assemble the two host handlers the compact skill answers.
*
* @param deps - the composition services captured at load.
* @returns the handler map to register on `ctx.rlmKernel`.
*/
function createCompactHostHandlers(deps) {
	const state = {
		pending: /* @__PURE__ */ new Map(),
		draining: /* @__PURE__ */ new Set()
	};
	return {
		"compact.run": (request, context) => Promise.resolve(runCompact(deps, state, request, context)),
		"compact.status": (_request, context) => runCompactStatus(deps, state, context)
	};
}
//#endregion
//#region lib/types/goal.js
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
/** Largest accepted objective length, in Unicode code points. */
const MAX_GOAL_OBJECTIVE_CHARS = 4e3;
/** Map one substrate phase onto the skill's status vocabulary. */
function wireStatus(view) {
	switch (view.phase) {
		case "active": return "active";
		case "paused": return "paused";
		case "complete": return "complete";
		case "blocked": return view.blockedReason?.code === "round-limit" ? "budget_limited" : "paused";
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
		updated_at: view.updatedAt
	};
}
/** Build the wire reply for one current view, or the empty reply without one. */
function goalHostResult(view, includeCompletionReport) {
	if (view === void 0) return {
		goal: null,
		remaining_tokens: null,
		completion_budget_report: null
	};
	return {
		goal: serializeGoal(view),
		remaining_tokens: null,
		completion_budget_report: includeCompletionReport && view.phase === "complete" ? `Goal achieved. Report final budget usage to the user: goal rounds used: ${view.roundsStarted} of ${view.maxGoalRounds}.` : null
	};
}
/** Read the required `objective` member of a `goal.create` payload. */
function objectiveField(data) {
	const value = data["objective"];
	if (typeof value !== "string") throw new Error("goal.create objective must be a string");
	return value;
}
/** Read the optional `token_budget` member of a `goal.create` payload. */
function tokenBudgetField(data) {
	const value = data["token_budget"];
	if (value === void 0) return void 0;
	if (typeof value !== "number") throw new Error("goal.create token_budget must be an integer when provided");
	return value;
}
/** Trim and bound one objective, mirroring the reference host's messages. */
function validateObjective(value) {
	const objective = value.trim();
	if (objective.length === 0) throw new Error("Goal objective must not be empty.");
	if (Array.from(objective).length > MAX_GOAL_OBJECTIVE_CHARS) throw new Error(`Goal objective must be at most ${MAX_GOAL_OBJECTIVE_CHARS} characters.`);
	return objective;
}
/** Check one requested token budget, mirroring the reference host's message. */
function validateTokenBudget(value) {
	if (value === void 0) return;
	if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) throw new Error("Goal token budget must be a positive integer.");
}
/** Reject a create while a non-terminal goal is still pending. */
function assertNoPendingGoal(view) {
	if (view === void 0 || view.phase === "complete") return;
	switch (wireStatus(view)) {
		case "active": throw new Error("cannot create a new goal because this thread already has an active goal; run `await goal.complete()` when it is achieved, or ask the user to clear it with /goal clear");
		case "paused": throw new Error("cannot create a new goal because a paused goal exists; ask the user to resume it with /goal resume or clear it with /goal clear");
		default: throw new Error("cannot create a new goal because a budget-limited goal exists; ask the user to resume it with /goal resume or clear it with /goal clear");
	}
}
/**
* Mount the three `goal.*` host handlers of the kernel-side goal skill.
*
* @param deps - the composition services the handlers drive.
* @returns handlers keyed by wire type, for `registerHostRequestHandlers`.
*/
function createGoalHostHandlers(deps) {
	return {
		"goal.get": (_request, context) => Promise.resolve(ok(goalHostResult(deps.goals.get(context.agent), false))),
		"goal.create": (request, context) => {
			const rawObjective = objectiveField(request.data);
			const tokenBudget = tokenBudgetField(request.data);
			assertNoPendingGoal(deps.goals.get(context.agent));
			const objective = validateObjective(rawObjective);
			validateTokenBudget(tokenBudget);
			const view = deps.goals.create(context.agent, { objective });
			return Promise.resolve(ok(goalHostResult(view, false)));
		},
		"goal.complete": (_request, context) => {
			const view = deps.goals.get(context.agent);
			if (view === void 0) throw new Error("cannot complete goal because this thread has no goal");
			const completed = view.phase === "complete" ? view : deps.goals.complete(context.agent, {
				id: view.id,
				revision: view.revision
			});
			return Promise.resolve(ok(goalHostResult(completed, true)));
		}
	};
}
//#endregion
//#region lib/types/heartbeat.js
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
/** Schedule a heartbeat falls back to when the request names no interval. */
const DEFAULT_HEARTBEAT_SCHEDULE = "every 5m";
const ONE_SECOND_MS = 1e3;
const ONE_MINUTE_MS = 6e4;
/** Largest delay a Node timer represents without clamping. */
const MAX_TIMER_DELAY_MS = 2147483647;
/** Strip one layer of matching quotes around a schedule text. */
function stripMatchingQuotes(value) {
	if (value.length >= 2 && (value.startsWith("\"") && value.endsWith("\"") || value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
	return value;
}
/** Expand the cron aliases the schedule parser accepts. */
function normalizeCronAlias(text) {
	switch (text) {
		case "@hourly": return "0 * * * *";
		case "@daily": return "0 0 * * *";
		case "@weekly": return "0 0 * * 0";
		case "@monthly": return "0 0 1 * *";
		default: return text;
	}
}
/** Parse one bounded cron number. */
function parseCronNumber(value, min, max) {
	if (!/^\d+$/.test(value)) throw new Error(`Invalid cron number: ${value}`);
	const parsed = Number.parseInt(value, 10);
	if (parsed < min || parsed > max) throw new Error(`Cron number out of range: ${value}`);
	return parsed;
}
/** Parse one cron field into the set of matching values. */
function parseCronField(field, min, max) {
	const values = /* @__PURE__ */ new Set();
	for (const part of field.split(",")) {
		if (!part) throw new Error(`Invalid cron field: ${field}`);
		const slash = part.indexOf("/");
		const rangeText = slash === -1 ? part : part.slice(0, slash);
		const step = slash === -1 ? 1 : parseCronNumber(part.slice(slash + 1), 1, max);
		let start;
		let end;
		if (rangeText === "*") {
			start = min;
			end = max;
		} else if (rangeText.includes("-")) {
			const dash = rangeText.indexOf("-");
			const tail = rangeText.slice(dash + 1);
			const secondDash = tail.indexOf("-");
			start = parseCronNumber(rangeText.slice(0, dash), min, max);
			end = parseCronNumber(secondDash === -1 ? tail : tail.slice(0, secondDash), min, max);
			if (start > end) throw new Error(`Invalid cron range: ${rangeText}`);
		} else {
			start = parseCronNumber(rangeText, min, max);
			end = start;
		}
		for (let value = start; value <= end; value += step) values.add(value);
	}
	return values;
}
/** Parse a five-field cron expression. */
function parseCronExpression(expression) {
	const parts = expression.trim().split(/\s+/);
	const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
	if (parts.length !== 5 || minute === void 0 || hour === void 0 || dayOfMonth === void 0 || month === void 0 || dayOfWeek === void 0) throw new Error("Unsupported cron schedule. Use 'in 10m', 'at <ISO date>', @hourly, or five fields: minute hour day month weekday");
	return {
		minute: parseCronField(minute, 0, 59),
		hour: parseCronField(hour, 0, 23),
		dayOfMonth: parseCronField(dayOfMonth, 1, 31),
		month: parseCronField(month, 1, 12),
		dayOfWeek: parseCronField(dayOfWeek, 0, 7)
	};
}
/** Whether one local-time instant matches every cron field. */
function matchesCronFields(date, fields) {
	const day = date.getDay();
	return fields.minute.has(date.getMinutes()) && fields.hour.has(date.getHours()) && fields.dayOfMonth.has(date.getDate()) && fields.month.has(date.getMonth() + 1) && (fields.dayOfWeek.has(day) || day === 0 && fields.dayOfWeek.has(7));
}
/** First local-time instant after `after` matching the cron expression. */
function nextCronRunAfter(expression, after) {
	const fields = parseCronExpression(expression);
	const candidate = new Date(after.getTime());
	candidate.setSeconds(0, 0);
	candidate.setMinutes(candidate.getMinutes() + 1);
	const deadline = candidate.getTime() + 527040 * ONE_MINUTE_MS;
	while (candidate.getTime() <= deadline) {
		if (matchesCronFields(candidate, fields)) return candidate;
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
function parseHeartbeatSchedule(input, now = /* @__PURE__ */ new Date()) {
	const text = stripMatchingQuotes(input.trim());
	if (!text) throw new Error("Cron schedule cannot be empty");
	const inMatch = /^in\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i.exec(text);
	if (inMatch) {
		const amount = Number.parseInt(String(inMatch[1]), 10);
		const unit = String(inMatch[2]).toLowerCase();
		const multiplier = unit.startsWith("m") ? ONE_MINUTE_MS : unit.startsWith("h") ? 60 * ONE_MINUTE_MS : 1440 * ONE_MINUTE_MS;
		return {
			schedule: {
				kind: "once",
				expression: text
			},
			nextRunAt: new Date(now.getTime() + amount * multiplier)
		};
	}
	const everyMatch = /^(?:every|each)\s+(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/i.exec(text);
	if (everyMatch) {
		const amount = Number.parseInt(String(everyMatch[1]), 10);
		const unit = String(everyMatch[2]).toLowerCase();
		const intervalMs = amount * (unit.startsWith("s") ? ONE_SECOND_MS : unit.startsWith("m") ? ONE_MINUTE_MS : 60 * ONE_MINUTE_MS);
		if (intervalMs < 1e4) throw new Error("Recurring interval must be at least 10 seconds");
		return {
			schedule: {
				kind: "interval",
				expression: text,
				intervalMs
			},
			nextRunAt: new Date(now.getTime() + intervalMs)
		};
	}
	if (text.toLowerCase().startsWith("at ")) {
		const when = new Date(text.slice(3).trim());
		if (!Number.isFinite(when.getTime())) throw new Error("Invalid one-shot schedule. Use: at <ISO date>");
		if (when.getTime() <= now.getTime()) throw new Error("One-shot schedule must be in the future");
		return {
			schedule: {
				kind: "once",
				expression: text
			},
			nextRunAt: when
		};
	}
	const expression = normalizeCronAlias(text);
	return {
		schedule: {
			kind: "cron",
			expression
		},
		nextRunAt: nextCronRunAfter(expression, now)
	};
}
/**
* Normalize a requested interval into schedule text: a missing interval falls
* back to the default, and a bare `5m`-style duration gains the `every` prefix.
*
* @param input - the requested interval, or `undefined`.
* @returns the schedule text to parse.
*/
function normalizeHeartbeatSchedule(input) {
	const text = input?.trim();
	if (!text) return DEFAULT_HEARTBEAT_SCHEDULE;
	if (/^\d+\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/i.test(text)) return `every ${text}`;
	return text;
}
/**
* Normalize a requested delivery mode, rejecting anything outside the vocabulary.
*
* @param value - the raw `delivery_mode` payload member.
* @returns the delivery mode, or `undefined` when none was given.
*/
function normalizeHeartbeatDeliveryMode(value) {
	if (value === void 0 || value === null) return;
	if (value === "steer" || value === "follow_up") return value;
	throw new Error("Heartbeat delivery mode must be \"steer\" or \"follow_up\"");
}
/**
* Compute the next run of a recurring schedule after one instant.
*
* @param schedule - the recurring schedule.
* @param after - the instant to start from.
* @returns the next run.
*/
function nextRunAtForSchedule(schedule, after) {
	if (schedule.kind === "interval") return new Date(after.getTime() + schedule.intervalMs);
	return nextCronRunAfter(schedule.expression, after);
}
/** Sort key ordering absent next-runs last; ISO texts compare chronologically. */
function nextRunAtSortKey(job) {
	return job.nextRunAt ?? "￿";
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
	if (!isRecord(value)) return void 0;
	const expression = value["expression"];
	if (typeof expression !== "string") return void 0;
	if (value["kind"] === "interval") {
		const intervalMs = value["intervalMs"];
		if (typeof intervalMs !== "number" || !Number.isSafeInteger(intervalMs) || intervalMs <= 0) return void 0;
		return {
			kind: "interval",
			expression,
			intervalMs
		};
	}
	if (value["kind"] === "cron") return {
		kind: "cron",
		expression
	};
}
/** Rebuild one persisted job row, or `undefined` when it is malformed. */
function rebuildJob(value) {
	if (!isRecord(value)) return void 0;
	const id = value["id"];
	const sessionId = value["sessionId"];
	const status = value["status"];
	const deliveryMode = value["deliveryMode"];
	const instruction = value["instruction"];
	const createdAt = value["createdAt"];
	const updatedAt = value["updatedAt"];
	const runCount = value["runCount"];
	const label = value["label"];
	const nextRunAt = value["nextRunAt"];
	const lastRunAt = value["lastRunAt"];
	const lastError = value["lastError"];
	if (typeof id !== "string" || typeof sessionId !== "string") return void 0;
	if (status !== "active" && status !== "paused" && status !== "cancelled") return void 0;
	if (deliveryMode !== "steer" && deliveryMode !== "follow_up") return void 0;
	if (typeof instruction !== "string" || typeof createdAt !== "string" || typeof updatedAt !== "string") return void 0;
	if (typeof runCount !== "number" || !Number.isSafeInteger(runCount)) return void 0;
	if (label !== void 0 && typeof label !== "string") return void 0;
	if (nextRunAt !== void 0 && typeof nextRunAt !== "string") return void 0;
	if (lastRunAt !== void 0 && typeof lastRunAt !== "string") return void 0;
	if (lastError !== void 0 && typeof lastError !== "string") return void 0;
	const schedule = rebuildSchedule(value["schedule"]);
	if (schedule === void 0) return void 0;
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
		...label === void 0 ? {} : { label },
		...nextRunAt === void 0 ? {} : { nextRunAt },
		...lastRunAt === void 0 ? {} : { lastRunAt },
		...lastError === void 0 ? {} : { lastError }
	};
}
/**
* The persistent heartbeat table: one JSON file holding every session's rows.
* Each operation re-reads the file so concurrent mutations never ride on a
* stale in-memory copy, and writes go through a rename so a crash mid-write
* cannot truncate the store.
*/
var HeartbeatStore = class {
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
		return this.readJobs().filter((job) => job.sessionId === sessionId && (options.includeInactive === true || job.status !== "cancelled")).sort((left, right) => nextRunAtSortKey(left).localeCompare(nextRunAtSortKey(right)));
	}
	/**
	* Create one active heartbeat. One-shot schedules and empty instructions
	* are rejected with the reference host's messages.
	*
	* @param input - the creation fields.
	* @returns the persisted row.
	*/
	create(input) {
		const now = input.now ?? /* @__PURE__ */ new Date();
		const parsed = parseHeartbeatSchedule(normalizeHeartbeatSchedule(input.interval), now);
		if (parsed.schedule.kind === "once") throw new Error("RLM heartbeat schedule must be recurring");
		const instruction = input.instruction.trim();
		if (!instruction) throw new Error("RLM heartbeat instruction cannot be empty");
		const label = input.label?.trim();
		const nowIso = now.toISOString();
		const job = {
			id: randomUUID(),
			sessionId: input.sessionId,
			status: "active",
			deliveryMode: input.deliveryMode ?? "steer",
			instruction,
			schedule: parsed.schedule,
			createdAt: nowIso,
			updatedAt: nowIso,
			nextRunAt: parsed.nextRunAt.toISOString(),
			runCount: 0,
			...label === void 0 || label === "" ? {} : { label }
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
		const now = update.now ?? /* @__PURE__ */ new Date();
		let updated;
		const jobs = this.readJobs().map((job) => {
			if (job.id !== id || job.sessionId !== sessionId) return job;
			if (job.status === "cancelled") return job;
			let next = { ...job };
			if (update.label !== void 0) {
				const label = update.label.trim();
				next = label === "" ? withoutLabel(next) : {
					...next,
					label
				};
			}
			if (update.deliveryMode !== void 0) next = {
				...next,
				deliveryMode: update.deliveryMode
			};
			if (update.instruction !== void 0) {
				const instruction = update.instruction.trim();
				if (!instruction) throw new Error("RLM heartbeat instruction cannot be empty");
				next = {
					...next,
					instruction
				};
			}
			if (update.interval !== void 0) {
				const parsed = parseHeartbeatSchedule(normalizeHeartbeatSchedule(update.interval), now);
				if (parsed.schedule.kind === "once") throw new Error("RLM heartbeat schedule must be recurring");
				next = next.status === "paused" ? withoutNextRunAt({
					...next,
					schedule: parsed.schedule
				}) : {
					...next,
					schedule: parsed.schedule,
					nextRunAt: parsed.nextRunAt.toISOString()
				};
			}
			if (update.status === "pause") next = withoutNextRunAt({
				...next,
				status: "paused"
			});
			else if (update.status === "resume") next = {
				...next,
				status: "active",
				nextRunAt: nextRunAtForSchedule(next.schedule, now).toISOString()
			};
			updated = {
				...next,
				updatedAt: now.toISOString()
			};
			return updated;
		});
		if (updated !== void 0) this.writeJobs(jobs);
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
	delete(sessionId, id, now = /* @__PURE__ */ new Date()) {
		let deleted;
		const jobs = this.readJobs().map((job) => {
			if (job.id !== id || job.sessionId !== sessionId) return job;
			deleted = withoutNextRunAt({
				...job,
				status: "cancelled",
				updatedAt: now.toISOString()
			});
			return deleted;
		});
		if (deleted !== void 0) this.writeJobs(jobs);
		return deleted;
	}
	/**
	* Cancel every live heartbeat of one session, for session teardown.
	*
	* @param sessionId - the owning session.
	* @param now - the cancellation time.
	* @returns the rows that were still live.
	*/
	cancelSession(sessionId, now = /* @__PURE__ */ new Date()) {
		const cancelled = [];
		const jobs = this.readJobs().map((job) => {
			if (job.sessionId !== sessionId || job.status === "cancelled") return job;
			const next = withoutNextRunAt({
				...job,
				status: "cancelled",
				updatedAt: now.toISOString()
			});
			cancelled.push(next);
			return next;
		});
		if (cancelled.length > 0) this.writeJobs(jobs);
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
			if (job.status !== "active" || job.nextRunAt === void 0) continue;
			const at = Date.parse(job.nextRunAt);
			if (selected === void 0 || at < selected) selected = at;
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
		return this.readJobs().filter((job) => job.status === "active" && job.nextRunAt !== void 0 && Date.parse(job.nextRunAt) <= time).sort((left, right) => nextRunAtSortKey(left).localeCompare(nextRunAtSortKey(right)));
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
		const now = result.now ?? /* @__PURE__ */ new Date();
		let updated;
		const jobs = this.readJobs().map((job) => {
			if (job.id !== id || job.status !== "active") return job;
			const { lastError: _lastError, ...rest } = job;
			updated = {
				...rest,
				lastRunAt: now.toISOString(),
				runCount: job.runCount + 1,
				nextRunAt: nextRunAtForSchedule(job.schedule, now).toISOString(),
				updatedAt: now.toISOString(),
				...result.error === void 0 ? {} : { lastError: renderThrown(result.error) }
			};
			return updated;
		});
		if (updated !== void 0) this.writeJobs(jobs);
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
	recordSkip(id, error, now = /* @__PURE__ */ new Date()) {
		let updated;
		const jobs = this.readJobs().map((job) => {
			if (job.id !== id || job.status !== "active") return job;
			updated = {
				...job,
				nextRunAt: nextRunAtForSchedule(job.schedule, now).toISOString(),
				lastError: error,
				updatedAt: now.toISOString()
			};
			return updated;
		});
		if (updated !== void 0) this.writeJobs(jobs);
		return updated;
	}
	readJobs() {
		if (!existsSync(this.filePath)) return [];
		let parsed;
		try {
			parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
		} catch {
			throw new Error(`RLM heartbeat store at ${JSON.stringify(this.filePath)} is corrupt`);
		}
		if (!isRecord(parsed)) throw new Error(`RLM heartbeat store at ${JSON.stringify(this.filePath)} is corrupt`);
		const raw = parsed["jobs"];
		if (!Array.isArray(raw)) throw new Error(`RLM heartbeat store at ${JSON.stringify(this.filePath)} is corrupt`);
		const entries = raw;
		const jobs = [];
		for (const entry of entries) {
			const job = rebuildJob(entry);
			if (job === void 0) throw new Error(`RLM heartbeat store at ${JSON.stringify(this.filePath)} is corrupt`);
			jobs.push(job);
		}
		return jobs;
	}
	writeJobs(jobs) {
		mkdirSync(dirname(this.filePath), { recursive: true });
		const temporary = `${this.filePath}.tmp`;
		writeFileSync(temporary, JSON.stringify({ jobs }), "utf8");
		renameSync(temporary, this.filePath);
	}
};
/** Producer source stamped on every delivered heartbeat prompt. */
const HEARTBEAT_MESSAGE_SOURCE = { kind: "rlm-heartbeat" };
/**
* Format the model-facing text of one heartbeat beat.
*
* @param job - the heartbeat that is due.
* @returns the header line plus the instruction.
*/
function formatHeartbeatPrompt(job) {
	return `[heartbeat: ${job.schedule.expression} run#${job.runCount}]\n\n${job.instruction}`;
}
/**
* Build the user message one due beat delivers into the owning session.
*
* @param job - the heartbeat that is due.
* @returns the identified message to steer or queue.
*/
function createHeartbeatMessage(job) {
	return createUserMessage({
		content: [{
			type: "text",
			text: formatHeartbeatPrompt(job)
		}],
		source: HEARTBEAT_MESSAGE_SOURCE
	});
}
/**
* The heartbeat controller behind the `rlm_heartbeat.*` host requests:
* CRUD against the store plus one re-armed timer that delivers due beats.
* Mutations wake the timer, and every fire re-arms it from the persisted
* table, so the file stays the single source of truth.
*/
var HeartbeatScheduler = class {
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
		const job = this.deps.store.create({
			...input,
			now: this.now()
		});
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
		const job = this.deps.store.update(sessionId, id, {
			...update,
			now: this.now()
		});
		if (job !== void 0) this.wake();
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
		if (job !== void 0) this.wake();
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
		if (jobs.length > 0) this.wake();
		return jobs;
	}
	/** Re-arm the timer from the persisted table. */
	wake() {
		if (this.disposed) return;
		this.clearTimer();
		let next;
		try {
			next = this.deps.store.nextActiveRunAt();
		} catch (error) {
			this.deps.onError?.(error);
			return;
		}
		if (next === void 0) return;
		const delay = Math.min(Math.max(0, next - this.now().getTime()), MAX_TIMER_DELAY_MS);
		this.timer = setTimeout(() => {
			this.timer = void 0;
			this.runDue();
		}, delay);
	}
	/** Deliver every beat due right now, then re-arm the timer. */
	runDue() {
		try {
			for (const job of this.deps.store.dueJobs(this.now())) this.deliver(job);
		} catch (error) {
			this.deps.onError?.(error);
		} finally {
			this.wake();
		}
	}
	now() {
		return this.deps.now?.() ?? /* @__PURE__ */ new Date();
	}
	clearTimer() {
		if (this.timer === void 0) return;
		clearTimeout(this.timer);
		this.timer = void 0;
	}
	deliver(job) {
		const target = this.deps.resolveAgent(job.sessionId);
		if (target === void 0) {
			this.deps.store.recordSkip(job.id, `RLM heartbeat target session ${JSON.stringify(job.sessionId)} is not live`, this.now());
			return;
		}
		const message = createHeartbeatMessage(job);
		let error;
		try {
			if (job.deliveryMode === "follow_up") target.followup(message);
			else target.steer(message);
		} catch (thrown) {
			error = thrown;
		}
		this.deps.store.recordRun(job.id, {
			now: this.now(),
			...error === void 0 ? {} : { error }
		});
	}
};
/**
* Project one persisted row onto its wire shape.
*
* @param job - the persisted row.
* @returns the snake_case reply row, with `null` for absent fields.
*/
function heartbeatWireRow(job) {
	return {
		id: job.id,
		status: job.status,
		label: job.label ?? null,
		delivery_mode: job.deliveryMode,
		instruction: job.instruction,
		schedule: job.schedule.kind === "interval" ? {
			kind: job.schedule.kind,
			expression: job.schedule.expression,
			intervalMs: job.schedule.intervalMs
		} : {
			kind: job.schedule.kind,
			expression: job.schedule.expression
		},
		created_at: job.createdAt,
		updated_at: job.updatedAt,
		next_run_at: job.nextRunAt ?? null,
		last_run_at: job.lastRunAt ?? null,
		last_error: job.lastError ?? null,
		run_count: job.runCount
	};
}
/** Read one optional string member of a request payload. */
function optionalStringField(data, key, message) {
	const value = data[key];
	if (value === void 0) return void 0;
	if (typeof value !== "string") throw new Error(message);
	return value;
}
/** Read the `status` member of an update payload, restricted to pause or resume. */
function heartbeatStatusField(value) {
	if (value === void 0) return void 0;
	if (value === "pause" || value === "resume") return value;
	throw new Error("rlm_heartbeat.update status must be \"pause\" or \"resume\" when provided");
}
/**
* Assemble the four host handlers answering the `rlm_heartbeat.*` requests.
* Validation messages match the reference host verbatim, because the kernel
* turns a thrown handler into the error reply the model reads.
*
* @param deps - the composition services captured at load.
* @returns the handler map to register on `ctx.rlmKernel`.
*/
function createHeartbeatHostHandlers(deps) {
	return {
		"rlm_heartbeat.list": (request, context) => {
			const includeInactive = request.data["include_inactive"] === true || request.data["includeInactive"] === true;
			return Promise.resolve(ok({ heartbeats: deps.heartbeats.list(String(context.agent.id), { includeInactive }).map(heartbeatWireRow) }));
		},
		"rlm_heartbeat.create": (request, context) => {
			const instruction = stringField(request.data, "instruction", "rlm_heartbeat.create instruction must be a string");
			const interval = optionalStringField(request.data, "interval", "rlm_heartbeat.create interval must be a string when provided");
			const label = optionalStringField(request.data, "label", "rlm_heartbeat.create label must be a string when provided");
			const deliveryMode = normalizeHeartbeatDeliveryMode(request.data["delivery_mode"] ?? request.data["deliveryMode"]);
			const heartbeat = deps.heartbeats.create({
				sessionId: String(context.agent.id),
				instruction,
				...interval === void 0 ? {} : { interval },
				...label === void 0 ? {} : { label },
				...deliveryMode === void 0 ? {} : { deliveryMode }
			});
			return Promise.resolve(ok({ heartbeat: heartbeatWireRow(heartbeat) }));
		},
		"rlm_heartbeat.update": (request, context) => {
			const id = stringField(request.data, "id", "rlm_heartbeat.update id must be a string");
			const instruction = optionalStringField(request.data, "instruction", "rlm_heartbeat.update instruction must be a string when provided");
			const interval = optionalStringField(request.data, "interval", "rlm_heartbeat.update interval must be a string when provided");
			const label = optionalStringField(request.data, "label", "rlm_heartbeat.update label must be a string when provided");
			const status = heartbeatStatusField(request.data["status"]);
			const rawDeliveryMode = request.data["delivery_mode"] ?? request.data["deliveryMode"];
			const deliveryMode = normalizeHeartbeatDeliveryMode(rawDeliveryMode);
			if (instruction === void 0 && interval === void 0 && label === void 0 && status === void 0 && rawDeliveryMode === void 0) throw new Error("rlm_heartbeat.update requires at least one field to update");
			const heartbeat = deps.heartbeats.update(String(context.agent.id), id, {
				...instruction === void 0 ? {} : { instruction },
				...interval === void 0 ? {} : { interval },
				...label === void 0 ? {} : { label },
				...status === void 0 ? {} : { status },
				...deliveryMode === void 0 ? {} : { deliveryMode }
			});
			return Promise.resolve(ok({ heartbeat: heartbeat === void 0 ? null : heartbeatWireRow(heartbeat) }));
		},
		"rlm_heartbeat.delete": (request, context) => {
			const id = stringField(request.data, "id", "rlm_heartbeat.delete id must be a string");
			const heartbeat = deps.heartbeats.delete(String(context.agent.id), id);
			return Promise.resolve(ok({ heartbeat: heartbeat === void 0 ? null : heartbeatWireRow(heartbeat) }));
		}
	};
}
//#endregion
//#region lib/types/mcp.js
/**
* Host bindings for the RLM Python runtime's `mcp.*` host requests. The
* kernel owns the MCP client itself (`py/rlm/mcp.py`); the host only answers
* where a server's connection configuration lives (`mcp.config`), refreshes a
* stored credential the kernel re-reads afterwards (`mcp.refresh`), and, when
* the composition wires an interactive login, starts one (`mcp.begin_login`).
*
* @module @deepseek-ai/dsh-rlm-bindings/mcp
*/
/** Structural guard for one entry of the servers file: a plain object with a known transport. */
function isMcpServerConfig(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	if (!("type" in value)) return false;
	return value.type === "http" || value.type === "stdio";
}
/**
* Reads the user-declared MCP server map from a JSON file. A missing,
* unreadable, or structurally invalid file reads as an empty map, so a
* broken file routes every server to the kernel's own "not declared" error
* instead of failing the host. Re-read on every call, so editing the file
* reaches the next kernel connection without a plugin restart.
*
* @param path - absolute path of the JSON file holding name → server config.
* @returns the declared servers, or an empty map when none can be read.
*/
function readMcpServersFile(path) {
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return {};
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
	const servers = {};
	for (const [name, value] of Object.entries(parsed)) if (isMcpServerConfig(value)) servers[name] = value;
	return servers;
}
/**
* Read the required `server` member of one `mcp.*` payload.
*
* @param data - the `host_request` payload.
* @param operation - the wire type the error message names.
* @returns the server name.
*/
function serverField(data, operation) {
	const value = data["server"];
	const server = typeof value === "string" ? value : "";
	if (server.length === 0) throw new Error(`${operation} requires a server`);
	return server;
}
/**
* Assemble the MCP host handlers the bindings answer.
*
* The map holds `mcp.config` and `mcp.refresh` unconditionally;
* `mcp.begin_login` appears only when the composition wired an interactive
* login, so the kernel never meets a handler whose only behavior is to throw.
*
* @param deps - the composition services captured at load.
* @returns the handler map to register on `ctx.rlmKernel`.
*/
function createMcpHostHandlers(deps) {
	const servers = deps.servers ?? (() => void 0);
	const handlers = {
		"mcp.config": (request) => {
			const server = serverField(request.data, "mcp.config");
			const config = servers()?.[server];
			return Promise.resolve(ok(config === void 0 ? {} : { ...config }));
		},
		"mcp.refresh": async (request) => {
			const server = serverField(request.data, "mcp.refresh");
			const refresh = deps.refreshCredential;
			const key = refresh === void 0 ? void 0 : await refresh(server);
			if (key !== void 0 && key.length > 0) return ok({});
			throw new Error(`Could not refresh credentials for ${server}`);
		}
	};
	const beginLogin = deps.beginLogin;
	if (beginLogin !== void 0) handlers["mcp.begin_login"] = async (request) => {
		const server = serverField(request.data, "mcp.begin_login");
		await beginLogin(server);
		return ok({});
	};
	return handlers;
}
/** Join the text blocks of one assistant message. */
function readAssistantText(message) {
	return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}
/**
* Human-readable account of one abnormally ended turn, for `collect` rows.
*
* @param reason - the closing turn's end reason, when the log recorded one.
* @returns the error text for the row.
*/
function formatTurnEndError(reason) {
	if (reason === void 0) return "the turn ended without a recorded reason";
	switch (reason.kind) {
		case "completed": return "the turn ended unexpectedly";
		case "aborted": return `the turn was aborted (${reason.reason.kind})`;
		case "blocked": return "the turn was blocked";
		case "error": return reason.error.message;
		case "max-tokens": return "the turn hit the output token ceiling";
		case "interrupted": return "the turn was interrupted";
		case "forked": return "the turn was left open at a fork boundary";
		default: return "the turn ended abnormally";
	}
}
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
function rlmActivityStaleMs(running, lastActivityAt, lastActivityMonotonicAt) {
	if (!running || lastActivityAt === void 0) return void 0;
	const wallStaleMs = Date.now() - lastActivityAt;
	const monotonicStaleMs = lastActivityMonotonicAt === void 0 ? wallStaleMs : performance.now() - lastActivityMonotonicAt;
	const staleMs = Math.floor(Math.min(wallStaleMs, monotonicStaleMs));
	return staleMs >= 6e5 ? staleMs : void 0;
}
/**
* Fold one child session's event cut and timing projection into roster facts.
*
* @param events - the child log's events at the observation cut.
* @param timing - the `subagentTiming` projection at the same cut, when mounted.
* @returns the folded facts; absent fields are omitted, never `undefined`-valued.
*/
function foldChildFacts(events, timing) {
	let toolUseCount = 0;
	let answerPreview;
	let lastAssistantSeq = -1;
	let lastUserSeq = -1;
	let lastTurnEnd;
	for (const event of events) if (event.type === "tool/call") toolUseCount += 1;
	else if (event.type === "assistant/message") {
		const text = compactRlmText(readAssistantText(event.data.message));
		if (text.length > 0) answerPreview = text;
		lastAssistantSeq = event.seq;
	} else if (event.type === "user/message") lastUserSeq = event.seq;
	else if (event.type === "turn/end") lastTurnEnd = event.data.reason;
	const running = timing?.active !== void 0;
	const durationMs = timing === void 0 ? void 0 : timing.settledMs + (timing.active === void 0 ? 0 : Math.max(0, timing.active.through - timing.active.since));
	const lastActivityAt = events.at(-1)?.time;
	const error = running || timing?.lastTurnCompleted !== false ? void 0 : formatTurnEndError(lastTurnEnd);
	return {
		running,
		...timing?.lastTurnCompleted === void 0 ? {} : { lastTurnCompleted: timing.lastTurnCompleted },
		...durationMs === void 0 ? {} : { durationMs },
		...toolUseCount === 0 ? {} : { toolUseCount },
		...answerPreview === void 0 ? {} : { answerPreview },
		...lastAssistantSeq < 0 ? {} : { repliedSinceTask: lastAssistantSeq > lastUserSeq },
		...lastActivityAt === void 0 ? {} : { lastActivityAt },
		...error === void 0 ? {} : { error }
	};
}
/** Refusal every out-of-family observation target receives. */
const AGENT_FAMILY_REACH_ERROR = "Agent reach is limited to parent, siblings, and children";
/**
* Join the text of one message's content blocks, one line per block.
*
* @param content - the content blocks of one persisted message.
* @returns the joined human-readable text; non-text blocks become placeholders.
*/
function contentText(content) {
	return content.map((block) => {
		switch (block.type) {
			case "text": return block.text;
			case "reasoning": return block.text;
			case "image": return "[image]";
			case "file": return "[file]";
			case "tool-call": return `[tool_call:${block.name}]`;
			default: return "";
		}
	}).filter((line) => line.length > 0).join("\n");
}
/**
* Fold one session event cut into its conversation messages, in log order.
*
* @param events - the session log's events at the observation cut.
* @returns the folded conversation messages, indexed in log order.
*/
function foldMessageEvents(events) {
	const messages = [];
	for (const event of events) if (event.type === "user/message") messages.push(foldMessage(event.time, event.data, messages.length));
	else if (event.type === "developer/message") messages.push(foldMessage(event.time, event.data.message, messages.length));
	else if (event.type === "system/message") messages.push(foldMessage(event.time, event.data.message, messages.length));
	else if (event.type === "assistant/message") messages.push(foldMessage(event.time, event.data.message, messages.length));
	else if (event.type === "tool/result") messages.push(foldMessage(event.time, event.data.message, messages.length));
	return messages;
}
/** Fold one carried message into its preview source row. */
function foldMessage(time, message, index) {
	const toolCalls = message.role === "assistant" ? message.content.filter((block) => block.type === "tool-call").map((block) => block.name) : void 0;
	return {
		index,
		role: message.role,
		timestamp: time,
		text: contentText(message.content),
		...toolCalls !== void 0 && toolCalls.length > 0 ? { toolCalls } : {}
	};
}
/**
* Clip one folded message to a bounded preview.
*
* @param message - the folded conversation message.
* @param maxChars - the preview size cap, in UTF-16 code units.
* @returns the wire preview, with `truncated` marking any clip.
*/
function createMessagePreview(message, maxChars) {
	const clipped = message.text.length > maxChars;
	return {
		index: message.index,
		role: message.role,
		timestamp: message.timestamp,
		text: clipped ? message.text.slice(0, maxChars) : message.text,
		truncated: clipped,
		...message.toolCalls === void 0 ? {} : { toolCalls: [...message.toolCalls] }
	};
}
/** Validate an optional integer payload member. */
function optionalInteger(value, label) {
	if (value === void 0) return void 0;
	if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${label} must be an integer when provided`);
	return value;
}
/** Clamp one bounded integer argument. */
function clampInteger(value, min, max, label) {
	if (value < min || value > max) throw new Error(`${label} must be between ${min} and ${max}`);
	return value;
}
/**
* Normalize the `limit` argument of one `agent_observe.recent` call.
*
* @param limit - the raw requested limit, when provided.
* @returns the bounded limit.
*/
function normalizeObserveLimit(limit) {
	return clampInteger(limit ?? 8, 1, 50, "agent_observe limit");
}
/**
* Normalize the `max_chars` argument of one `agent_observe.recent` call.
*
* @param maxChars - the raw requested preview size, when provided.
* @returns the bounded preview size.
*/
function normalizeObserveMaxChars(maxChars) {
	return clampInteger(maxChars ?? 800, 80, 2e3, "agent_observe max_chars");
}
/**
* Derive the calling session's nuclear family from its durable header and
* the subagent catalogs. A subagent child's siblings are its parent's other
* catalog children; a top-level session's siblings are the other live roots,
* matching the roots-are-siblings reach rule. Deeper ancestors and their
* descendants stay unreachable: communication with them relays through the
* intermediate family member.
*
* @param source - the composition services the catalog is derived from.
* @param agent - the calling session's agent.
* @param signal - cancellation while reading the catalogs.
* @returns the family snapshot: own display name plus reachable members.
*/
async function listFamilyMembers(source, agent, signal) {
	const currentId = String(agent.id);
	const parentId = agent.session.header.parentSession;
	const byName = (left, right) => left.name.localeCompare(right.name);
	const members = [];
	let selfName = currentId;
	if (parentId !== void 0) {
		const pid = String(parentId);
		members.push({
			relationship: "parent",
			id: pid,
			name: pid,
			...liveMember(source, parentId)
		});
		const siblings = [];
		for (const entry of await source.subagents.listChildren(parentId, signal)) {
			const id = String(entry.id);
			const name = source.roster.entry(pid, id)?.name ?? entry.label ?? id;
			if (id === currentId) {
				selfName = name;
				continue;
			}
			siblings.push({
				relationship: "sibling",
				id,
				name,
				...liveMember(source, entry.id)
			});
		}
		siblings.sort(byName);
		members.push(...siblings);
	} else {
		const roots = [];
		for (const root of source.agents.roots()) {
			if (root.id === agent.id) continue;
			roots.push({
				relationship: "sibling",
				id: String(root.id),
				name: String(root.id),
				agent: root
			});
		}
		roots.sort(byName);
		members.push(...roots);
	}
	const children = [];
	for (const entry of await source.subagents.listChildren(agent.id, signal)) {
		const id = String(entry.id);
		const name = source.roster.entry(currentId, id)?.name ?? entry.label ?? id;
		children.push({
			relationship: "child",
			id,
			name,
			...liveMember(source, entry.id)
		});
	}
	children.sort(byName);
	members.push(...children);
	return {
		selfName,
		members
	};
}
/** Spread the live-agent field of one family member, when resident. */
function liveMember(source, id) {
	const agent = source.agents.get(id);
	return agent === void 0 ? {} : { agent };
}
/** Project one matched candidate onto its observation target. */
function toObserveTarget(candidate) {
	return candidate.kind === "current" ? {
		id: candidate.id,
		options: {
			current: true,
			name: candidate.name
		}
	} : {
		id: candidate.member.id,
		options: {
			relationship: candidate.member.relationship,
			name: candidate.member.name
		}
	};
}
/**
* Resolve one `agent_observe.get` / `agent_observe.recent` target selector
* against the calling session and its reachable family, by exact id or name
* first and by unambiguous suffix second.
*
* @param deps - the composition services.
* @param agent - the calling session's agent.
* @param target - the raw target selector.
* @param signal - cancellation while reading the catalogs.
* @returns the resolved target.
*/
async function resolveObserveTarget(deps, agent, target, signal) {
	const family = await listFamilyMembers(deps, agent, signal);
	const candidates = [{
		kind: "current",
		id: String(agent.id),
		name: family.selfName
	}, ...family.members.map((member) => ({
		kind: "member",
		member,
		id: member.id,
		name: member.name
	}))];
	const exact = candidates.filter((candidate) => candidate.id === target || candidate.name === target);
	const [first, second] = exact.length > 0 ? exact : candidates.filter((candidate) => candidate.id.endsWith(target) || candidate.name.endsWith(target));
	if (first === void 0) throw new Error(AGENT_FAMILY_REACH_ERROR);
	if (second !== void 0) throw new Error(`agent_observe target ${JSON.stringify(target)} is ambiguous`);
	return toObserveTarget(first);
}
/**
* The coarse runtime classification of one session, from its durable header.
*
* @param header - the session's durable identity metadata.
* @returns `subagent` for a delegated child, `top-level` otherwise.
*/
function headerRuntimeKind(header) {
	return (header.delegationDepth ?? 0) > 0 || header.origin === "subagent" ? "subagent" : "top-level";
}
/** Project one session cut plus live-registry facts onto a wire summary. */
function summarizeCut(deps, cut, id, options) {
	const facts = foldChildFacts(cut.events, cut.projections?.values.subagentTiming);
	const messages = foldMessageEvents(cut.events);
	const live = deps.agents.get(SessionId(id));
	const header = cut.header;
	const running = facts.running;
	const firstUser = messages.find((message) => message.role === "user");
	const latest = messages.at(-1);
	return {
		...live === void 0 ? {} : { activeSessionId: id },
		sessionId: id,
		sessionName: options.name,
		...options.relationship === void 0 ? {} : { relationship: options.relationship },
		runtimeKind: headerRuntimeKind(header),
		...header.cwd === void 0 ? {} : { cwd: header.cwd },
		status: running ? "model" : live === void 0 ? "inactive" : "idle",
		isCurrent: options.current === true,
		isStreaming: live !== void 0 && running,
		isCompacting: false,
		attachedClients: 0,
		messageCount: messages.length,
		queuedCount: live === void 0 ? 0 : live.inbox.nextTurn.length + live.inbox.nextStep.length,
		isSessionActive: live !== void 0,
		...facts.repliedSinceTask === void 0 ? {} : { repliedSinceTask: facts.repliedSinceTask },
		...header.parentSession === void 0 ? {} : { parentSessionId: String(header.parentSession) },
		...firstUser === void 0 ? {} : { firstMessage: firstUser.text.slice(0, 240) },
		...latest === void 0 ? {} : { latestMessage: createMessagePreview(latest, 240) }
	};
}
/** Observe one session and project its wire summary, disposing the lease. */
async function summarizeSession(deps, id, options, signal) {
	const cut = await deps.observations.observeSession(SessionId(id), {
		signal,
		projectionMode: "all"
	});
	try {
		return summarizeCut(deps, cut, id, options);
	} finally {
		cut[Symbol.dispose]();
	}
}
/** Answer `agent_observe.list`: the calling session plus its whole family. */
async function runList(deps, context) {
	const family = await listFamilyMembers(deps, context.agent, context.signal);
	const agents = [];
	for (const member of family.members) agents.push(await summarizeSession(deps, member.id, {
		relationship: member.relationship,
		name: member.name
	}, context.signal));
	return ok({
		current: await summarizeSession(deps, String(context.agent.id), {
			current: true,
			name: family.selfName
		}, context.signal),
		agents
	});
}
/** Answer `agent_observe.get`: one reachable session's summary. */
async function runGet(deps, data, context) {
	const target = stringField(data, "target", "agent_observe.get target must be a string");
	const resolved = await resolveObserveTarget(deps, context.agent, target, context.signal);
	return ok({ agent: await summarizeSession(deps, resolved.id, resolved.options, context.signal) });
}
/** Answer `agent_observe.recent`: bounded recent message previews of one reachable session. */
async function runRecent(deps, data, context) {
	const target = stringField(data, "target", "agent_observe.recent target must be a string");
	const limit = normalizeObserveLimit(optionalInteger(data["limit"], "agent_observe.recent limit"));
	const maxChars = normalizeObserveMaxChars(optionalInteger(data["max_chars"] ?? data["maxChars"], "agent_observe.recent max_chars"));
	const resolved = await resolveObserveTarget(deps, context.agent, target, context.signal);
	const cut = await deps.observations.observeSession(SessionId(resolved.id), {
		signal: context.signal,
		projectionMode: "all"
	});
	try {
		const messages = foldMessageEvents(cut.events);
		const startIndex = Math.max(0, messages.length - limit);
		return ok({
			agent: summarizeCut(deps, cut, resolved.id, resolved.options),
			messages: messages.slice(startIndex).map((message) => createMessagePreview(message, maxChars)),
			limit,
			maxChars,
			truncated: startIndex > 0
		});
	} finally {
		cut[Symbol.dispose]();
	}
}
/**
* Assemble the three observation handlers the agent-observe skill calls.
*
* @param deps - the composition services captured at load.
* @returns the handler map to register on `ctx.rlmKernel`.
*/
function createAgentObserveHostHandlers(deps) {
	return {
		"agent_observe.list": (_request, context) => runList(deps, context),
		"agent_observe.get": (request, context) => runGet(deps, request.data, context),
		"agent_observe.recent": (request, context) => runRecent(deps, request.data, context)
	};
}
//#endregion
//#region lib/types/message.js
/**
* Session-to-session messaging behind the agent-message skill. Routing is
* nuclear-family only: the sender resolves its parent, siblings, or direct
* children from the subagent catalogs, and the message is steered into the
* resolved live session as a user message stamped with the bindings source.
* A running target admits the steering at its nearest step boundary, which
* the receipt reports as queued; an idle target starts a turn, reported as
* delivered.
*
* @module @deepseek-ai/dsh-rlm-bindings/message
*/
/** Producer source stamped on every steered agent message. */
const AGENT_MESSAGE_STEER_SOURCE = { kind: "rlm-bindings" };
/** Durable source name carried by every agent-message receipt. */
const AGENT_MESSAGE_SOURCE = "agent_message";
/** Identity prefix distinguishing agent-to-agent messages. */
const AGENT_MESSAGE_ID_PREFIX = "agentmsg_";
/** Hard cap for one agent message, in UTF-16 code units. */
const DEFAULT_AGENT_MESSAGE_MAX_CHARS = 16384;
/** Reply one removed wire type always fails with. */
const REMOVED_LIST_AGENTS_MESSAGE = "agent_message.list_agents was removed; the family roster now lives in agent_observe.list_agents(). Restart the Python kernel to load the current skills, then call await agent_observe.list_agents().";
/**
* Token-bucket limiter over sender-target pairs, ported from the reference
* host: one token per send, refilled one per interval up to the capacity,
* with a refund when the delivery itself fails.
*/
var AgentMessageRateLimiter = class {
	capacity;
	refillMs;
	now;
	buckets = /* @__PURE__ */ new Map();
	/**
	* @param options - tuning knobs; defaults match the reference host.
	*/
	constructor(options = {}) {
		this.capacity = options.capacity ?? 3;
		this.refillMs = options.refillMs ?? 1e3;
		this.now = options.now ?? (() => Date.now());
	}
	/**
	* Take one token for a sender-target pair.
	*
	* @param key - the sender-target pair key.
	* @returns success, or the wait until the next token.
	*/
	tryConsume(key) {
		const now = this.now();
		const bucket = this.buckets.get(key) ?? {
			tokens: this.capacity,
			updatedAt: now
		};
		const elapsed = Math.max(0, now - bucket.updatedAt);
		const refilledTokens = Math.floor(elapsed / this.refillMs);
		if (refilledTokens > 0) {
			bucket.tokens = Math.min(this.capacity, bucket.tokens + refilledTokens);
			bucket.updatedAt += refilledTokens * this.refillMs;
		}
		if (bucket.tokens <= 0) {
			this.buckets.set(key, bucket);
			return {
				ok: false,
				retryAfterMs: Math.max(1, bucket.updatedAt + this.refillMs - now)
			};
		}
		bucket.tokens -= 1;
		this.buckets.set(key, bucket);
		return { ok: true };
	}
	/**
	* Return one token after a failed delivery, so a send that never happened
	* does not spend the pair's budget.
	*
	* @param key - the sender-target pair key.
	*/
	refund(key) {
		const bucket = this.buckets.get(key);
		if (bucket === void 0) return;
		bucket.tokens = Math.min(this.capacity, bucket.tokens + 1);
		this.buckets.set(key, bucket);
	}
};
/**
* Normalize one outbound agent message: trimmed, non-empty, and within the
* size cap. The error texts are model-facing and match the reference host.
*
* @param message - the raw message text.
* @param maxChars - the size cap.
* @returns the normalized message.
*/
function normalizeAgentSessionMessage(message, maxChars = DEFAULT_AGENT_MESSAGE_MAX_CHARS) {
	const trimmed = message.trim();
	if (trimmed.length === 0) throw new Error("Agent session message cannot be empty");
	if (trimmed.length > maxChars) throw new Error(`Agent session message is too long: ${trimmed.length} chars exceeds ${maxChars}`);
	return trimmed;
}
/**
* Mint the identity of one outbound agent message.
*
* @returns a fresh `agentmsg_`-prefixed id.
*/
function createAgentMessageId() {
	return `${AGENT_MESSAGE_ID_PREFIX}${randomUUID()}`;
}
/**
* The sender's relationship from the receiver's point of view: the inverse
* of the receiver role the send was addressed with.
*
* @param receiverRole - the role the receiver was addressed with.
* @returns the sender's relationship to the receiver.
*/
function inverseRelationship(receiverRole) {
	switch (receiverRole) {
		case "parent": return "child";
		case "child": return "parent";
		case "sibling": return "sibling";
	}
}
/**
* Strip the characters that would break the bracket header line of a steered
* agent message: brackets, newlines, commas, and the relationship separator.
*
* @param value - a display name interpolated into the header.
* @returns the safe header value, or `unknown` when nothing survives.
*/
function sanitizeMessageHeaderValue(value) {
	return value.replace(/[\s,:[\]]+/g, " ").trim() || "unknown";
}
/**
* Format the model-facing text of one steered agent message, matching the
* reference host's bracket grammar.
*
* @param fromRelationship - the sender's relationship from the receiver's point of view.
* @param senderName - the sender's display name, sanitized for the header.
* @param message - the normalized message text.
* @returns the text the receiving session reads.
*/
function formatAgentMessagePrompt(fromRelationship, senderName, message) {
	return `[agent-message from ${fromRelationship}:${sanitizeMessageHeaderValue(senderName)}]\n\n${message}`;
}
/** Normalize and deliver one message to one resolved family member. */
function sendOne(deps, limiter, sender, senderName, member, rawMessage, receiverRole) {
	const message = normalizeAgentSessionMessage(rawMessage);
	if (member.id === String(sender.id)) throw new Error("Agent messaging cannot target the sending session");
	const key = `${String(sender.id)}->${member.id}`;
	const lease = limiter.tryConsume(key);
	if (!lease.ok) throw new Error(`Agent messaging rate limit exceeded; retry after ${lease.retryAfterMs}ms`);
	const target = member.agent ?? deps.agents.get(SessionId(member.id));
	if (target === void 0) {
		limiter.refund(key);
		throw new Error(`agent_message.send: target session "${member.name}" is not live in this host`);
	}
	const steered = createUserMessage({
		content: [{
			type: "text",
			text: formatAgentMessagePrompt(inverseRelationship(receiverRole), senderName, message)
		}],
		source: AGENT_MESSAGE_STEER_SOURCE
	});
	const queued = target.status === "running";
	try {
		target.steer(steered);
	} catch (error) {
		limiter.refund(key);
		throw error;
	}
	const at = (/* @__PURE__ */ new Date()).toISOString();
	return {
		id: createAgentMessageId(),
		source: AGENT_MESSAGE_SOURCE,
		target: {
			activeSessionId: member.id,
			sessionId: member.id,
			sessionName: member.name,
			runtimeKind: headerRuntimeKind(target.session.header)
		},
		from: {
			activeSessionId: String(sender.id),
			sessionId: String(sender.id),
			sessionName: senderName,
			runtimeKind: headerRuntimeKind(sender.session.header)
		},
		message,
		deliveryStatus: queued ? "queued" : "delivered",
		...queued ? { queuedAt: at } : { deliveredAt: at },
		deliveryMode: "steer"
	};
}
/** Read the failure text of one settled broadcast leg. */
function rejectionMessage(reason) {
	return reason instanceof Error ? reason.message : String(reason);
}
/** Read the validated `message` member of one `agent_message.send` payload. */
function stringMessage(request) {
	const message = request["message"];
	if (typeof message !== "string") throw new Error("agent_message.send message must be a string");
	return message;
}
/** Answer `agent_message.send` addressed with `target: "all"`: every family member. */
async function runBroadcast(deps, limiter, rawMessage, request, context) {
	if (request["receiver_role"] !== void 0 || request["receiver_name"] !== void 0) throw new Error("agent_message.send broadcast cannot be combined with receiver_role/receiver_name");
	const family = await listFamilyMembers(deps, context.agent, context.signal);
	const receipts = [];
	for (const member of family.members) try {
		receipts.push(sendOne(deps, limiter, context.agent, family.selfName, member, rawMessage, member.relationship));
	} catch (error) {
		receipts.push({
			target: member.id,
			error: rejectionMessage(error)
		});
	}
	return ok({ receipts });
}
/** Answer `agent_message.send` addressed with receiver_role and receiver_name. */
async function runSend(deps, limiter, request, context) {
	const rawMessage = stringMessage(request);
	const target = request["target"];
	if (target !== void 0) {
		if (target !== "all") throw new Error("positional agent_message.send targets are not supported; use receiver_role and receiver_name");
		return runBroadcast(deps, limiter, rawMessage, request, context);
	}
	const role = request["receiver_role"];
	if (role !== "parent" && role !== "sibling" && role !== "child") throw new Error("agent_message.send receiver_role must be \"parent\", \"sibling\", or \"child\"");
	const receiverName = request["receiver_name"];
	if (role === "parent" && receiverName !== void 0 && receiverName !== null) throw new Error("agent_message.send receiver_name must be omitted for parent messages");
	if (role !== "parent" && (typeof receiverName !== "string" || receiverName.trim().length === 0)) throw new Error("agent_message.send receiver_name is required for sibling and child messages");
	const selector = typeof receiverName === "string" ? receiverName.trim() : void 0;
	const family = await listFamilyMembers(deps, context.agent, context.signal);
	const [first, second] = family.members.filter((member) => member.relationship === role && (role === "parent" || member.name === selector || member.id === selector));
	if (first === void 0) throw new Error(`No ${role} matches ${role === "parent" ? "the current agent" : JSON.stringify(receiverName)}`);
	if (second !== void 0) throw new Error(`${role} selector ${JSON.stringify(receiverName)} is ambiguous`);
	return ok(sendOne(deps, limiter, context.agent, family.selfName, first, rawMessage, role));
}
/**
* Assemble the messaging handlers the agent-message skill calls.
*
* @param deps - the composition services captured at load.
* @returns the handler map to register on `ctx.rlmKernel`.
*/
function createAgentMessageHostHandlers(deps) {
	const limiter = new AgentMessageRateLimiter(deps.rateLimit ?? {});
	return {
		"agent_message.list_agents": () => Promise.reject(/* @__PURE__ */ new Error(REMOVED_LIST_AGENTS_MESSAGE)),
		"agent_message.send": (request, context) => runSend(deps, limiter, request.data, context)
	};
}
//#endregion
//#region lib/types/model-info.js
/**
* Host handler for the `model.info` request: the calling agent's own route
* and its accepted input modalities. The reference host reads these off the
* live model object; here the route comes from the agent's options and the
* modalities from `ctx.llm`'s adapter-resolved metadata, degrading to an
* empty list when the route cannot be resolved.
*
* @module @deepseek-ai/dsh-rlm-bindings/model-info
*/
/** Read the calling agent's route, resolving modalities best-effort. */
async function modelInfo(deps, context) {
	const provider = context.agent.options.provider;
	const model = context.agent.options.model;
	if (provider === void 0 || model === void 0) return {
		id: model ?? null,
		provider: provider ?? null,
		input: []
	};
	let input = [];
	try {
		input = (await deps.models.resolveModelInfo(provider, model, context.signal)).inputModalities ?? [];
	} catch {
		input = [];
	}
	return {
		id: model,
		provider,
		input: [...input]
	};
}
/**
* Assemble the host handler answering `model.info`.
*
* @param deps - the composition services captured at load.
* @returns the handler map to register on `ctx.rlmKernel`.
*/
function createModelInfoHostHandlers(deps) {
	return { "model.info": async (_request, context) => ok(await modelInfo(deps, context)) };
}
//#endregion
//#region lib/types/refine.js
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
/** Producer source stamped on every refinement request notice. */
const REFINE_REQUEST_SOURCE = { kind: "rlm-bindings" };
/** Model-facing note of an accepted `refine.run`, mirroring the reference host. */
const REFINE_SCHEDULED_NOTE = "Refinement runs when the current turn ends; the request is then steered into your context as a refinement notice and you resume automatically. Continue working normally.";
/** Model-facing reason of a `refine.run` refused outside an active turn. */
const REFINE_NO_ACTIVE_TURN_REASON = "no active turn; refine can only be requested while a turn is running";
/**
* Per-agent scheduled refinement state. The state is in-process and volatile:
* a host restart drops pending requests and in-flight stamps, matching the
* roster's durability policy.
*/
var RefineRequests = class {
	states = /* @__PURE__ */ new Map();
	/**
	* Schedule one refinement for an agent, merging over any earlier request of
	* the same turn: a repeated `refine.run` only updates the fields it carries.
	*
	* @param agentId - the requesting session's id.
	* @param update - the validated `refine.run` arguments.
	*/
	schedule(agentId, update) {
		let state = this.states.get(agentId);
		if (state === void 0) {
			state = { inFlight: false };
			this.states.set(agentId, state);
		}
		const instructions = update.instructions ?? state.pending?.instructions;
		const global = update.global ?? state.pending?.global;
		state.pending = {
			...instructions === void 0 ? {} : { instructions },
			...global === void 0 ? {} : { global }
		};
	}
	/**
	* Whether one agent has a refinement queued for its current turn.
	*
	* @param agentId - the session's id.
	* @returns the pending flag of the `refine.status` reply.
	*/
	isPending(agentId) {
		return this.states.get(agentId)?.pending !== void 0;
	}
	/**
	* Whether one agent's refinement was consumed at a turn boundary and its
	* notice has not yet worked through the reopened turn.
	*
	* @param agentId - the session's id.
	* @returns the in-flight flag of the `refine.status` reply.
	*/
	isInFlight(agentId) {
		return this.states.get(agentId)?.inFlight === true;
	}
	/**
	* Take one agent's pending request at its turn boundary, marking the
	* refinement in flight.
	*
	* @param agentId - the session whose turn is closing.
	* @returns the scheduled request, or `undefined` when none is pending.
	*/
	consume(agentId) {
		const state = this.states.get(agentId);
		const pending = state?.pending;
		if (state === void 0 || pending === void 0) return void 0;
		delete state.pending;
		state.inFlight = true;
		return pending;
	}
	/**
	* Clear one agent's in-flight stamp when its turn boundary arrives with no
	* further pending request.
	*
	* @param agentId - the session whose turn is closing.
	*/
	settle(agentId) {
		const state = this.states.get(agentId);
		if (state === void 0) return;
		state.inFlight = false;
	}
	/**
	* Drop every refinement state of one agent, e.g. on disposal.
	*
	* @param agentId - the disposed session's id.
	*/
	forget(agentId) {
		this.states.delete(agentId);
	}
};
/**
* Read and validate the arguments of one `refine.run` payload, with the
* reference host's error messages.
*
* @param data - the `host_request` payload.
* @returns the validated request update.
*/
function refineRunField(data) {
	const instructions = data["instructions"];
	if (instructions !== void 0 && typeof instructions !== "string") throw new Error("refine.run instructions must be a string when provided");
	const global = data["global"];
	if (global !== void 0 && typeof global !== "boolean") throw new Error("refine.run global must be a boolean when provided");
	return {
		...instructions === void 0 ? {} : { instructions },
		...global === void 0 ? {} : { global }
	};
}
/**
* Format the model-facing text of one refinement request notice.
*
* @param request - the scheduled refinement consumed at the turn boundary.
* @returns the header line, the instruction body, and the optional focus.
*/
function formatRefineRequestNotice(request) {
	return `[refine-requested scope:${request.global === true ? "global" : "local"}]\n\n${request.global === true ? "A continual harness refinement of the global, cross-session store was scheduled for this turn boundary. This host has no separate refinement planner, so perform the refinement yourself now: review the recent trajectory and apply small, evidence-backed edits through `rlm.harness`, keeping only stable cross-session lessons, durable user preferences, and reusable skills or subagent specs in the global store. Then continue your task." : "A continual harness refinement of this session's local store was scheduled for this turn boundary. This host has no separate refinement planner, so perform the refinement yourself now: review the recent trajectory and apply small, evidence-backed edits to the continual harness (prompt notes, memories, skills, subagent specs) through `rlm.harness`. Do not rewrite the whole harness when one focused entry is enough. Then continue your task."}${request.instructions === void 0 ? "" : `\n\nFocus: ${request.instructions}`}`;
}
/**
* Build the steered user message carrying one refinement request.
*
* @param request - the scheduled refinement consumed at the turn boundary.
* @returns the identified message to steer into the requesting session.
*/
function createRefineRequestMessage(request) {
	return createUserMessage({
		content: [{
			type: "text",
			text: formatRefineRequestNotice(request)
		}],
		source: REFINE_REQUEST_SOURCE
	});
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
function createRefineTurnStopping(deps) {
	return ({ agent }) => {
		const agentId = String(agent.id);
		const pending = deps.requests.consume(agentId);
		if (pending === void 0) {
			deps.requests.settle(agentId);
			return;
		}
		agent.steer(createRefineRequestMessage(pending));
	};
}
/**
* Assemble the two host handlers the refine skill's wires answer.
*
* @param deps - the shared per-agent refinement state.
* @returns the handler map to register on `ctx.rlmKernel`.
*/
function createRefineHostHandlers(deps) {
	return {
		"refine.status": (_request, context) => {
			const agentId = String(context.agent.id);
			return Promise.resolve(ok({
				pending: deps.requests.isPending(agentId),
				in_flight: deps.requests.isInFlight(agentId)
			}));
		},
		"refine.run": (request, context) => {
			const update = refineRunField(request.data);
			if (context.agent.status !== "running") return Promise.resolve(ok({
				scheduled: false,
				reason: REFINE_NO_ACTIVE_TURN_REASON
			}));
			deps.requests.schedule(String(context.agent.id), update);
			return Promise.resolve(ok({
				scheduled: true,
				note: REFINE_SCHEDULED_NOTE
			}));
		}
	};
}
//#endregion
//#region lib/types/roster.js
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
const RLM_PROGRESS_NOTE_MIN_INTERVAL_MS = 1e4;
/**
* Per-composition roster of RLM children, grouped by parent session. Name
* reservation is synchronous so two overlapping spawns can never claim one
* sibling name; every later lookup is O(1).
*/
var Roster = class {
	parents = /* @__PURE__ */ new Map();
	reservations = /* @__PURE__ */ new Map();
	childParent = /* @__PURE__ */ new Map();
	entryOf(childId) {
		const parent = this.childParent.get(childId);
		return parent === void 0 ? void 0 : this.parents.get(parent)?.byChild.get(childId);
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
		if (this.parents.get(parent)?.byName.has(name) === true || this.reservations.get(parent)?.has(name) === true) throw new Error(`${operation} name "${name}" is already used by a sibling in the current parent session`);
		let names = this.reservations.get(parent);
		if (names === void 0) {
			names = /* @__PURE__ */ new Set();
			this.reservations.set(parent, names);
		}
		names.add(name);
		let released = false;
		return () => {
			if (released) return;
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
		if (roster === void 0) {
			roster = {
				byChild: /* @__PURE__ */ new Map(),
				byName: /* @__PURE__ */ new Map()
			};
			this.parents.set(parent, roster);
		}
		roster.byChild.set(admission.childId, {
			...admission,
			notes: []
		});
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
		if (roster === void 0 || entry === void 0) return;
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
		if (entry === void 0) return void 0;
		const last = entry.lastNoteAt;
		if (last !== void 0 && now - last < 1e4) return {
			accepted: false,
			retryAfterMs: RLM_PROGRESS_NOTE_MIN_INTERVAL_MS - (now - last)
		};
		entry.lastNoteAt = now;
		entry.notes.push(message);
		if (entry.notes.length > 5) entry.notes.shift();
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
		if (entry === void 0 || entry.lastActivityEventTime === eventTime) return;
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
};
//#endregion
//#region lib/types/models.js
/**
* `rlm.find_models`: search the composition's advertised model catalog without
* adding it to the system prompt. Scoring mirrors the reference host: exact
* matches beat prefix matches beat substring matches, ties break by selector.
*
* @module @deepseek-ai/dsh-rlm-bindings/models
*/
/** Lowercase alphanumeric fold for search text. */
function normalizeModelSearchText(value) {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}
/**
* Score and rank the catalog matches of one query.
*
* @param query - the raw search text; an empty query ranks everything equally.
* @param models - the catalog entries under test.
* @param limit - the maximum number of matches returned.
* @returns the best `limit` matches, best first.
*/
function scoreRlmModelMatches(query, models, limit) {
	const normalizedQuery = normalizeModelSearchText(query.trim());
	return models.map((model) => {
		const selector = `${model.provider}/${model.id}`;
		const normalizedFields = [
			selector,
			model.id,
			model.name || model.id
		].map(normalizeModelSearchText);
		let score = normalizedQuery.length > 0 ? Number.POSITIVE_INFINITY : 0;
		if (normalizedQuery.length > 0) {
			const exactIndex = normalizedFields.indexOf(normalizedQuery);
			const prefixIndex = normalizedFields.findIndex((field) => field.startsWith(normalizedQuery));
			const partialIndex = normalizedFields.findIndex((field) => field.includes(normalizedQuery));
			if (exactIndex >= 0) score = exactIndex;
			else if (prefixIndex >= 0) score = 3 + prefixIndex;
			else if (partialIndex >= 0) score = 6 + partialIndex;
		}
		return {
			model,
			selector,
			score
		};
	}).filter((candidate) => Number.isFinite(candidate.score)).sort((a, b) => a.score - b.score || a.selector.localeCompare(b.selector)).slice(0, limit).map(({ model, selector }) => ({
		provider: model.provider,
		id: model.id,
		name: model.name || model.id,
		selector
	}));
}
/**
* Search every registered provider's advertised models for one query.
*
* @param catalog - the model catalog to search.
* @param query - the raw search text.
* @param limit - the maximum number of matches returned.
* @returns the best `limit` matches, best first.
*/
async function findRlmModels(catalog, query, limit) {
	const models = [];
	for (const provider of catalog.listProviders()) models.push(...await catalog.listModels(provider.id));
	return scoreRlmModelMatches(query, models, limit);
}
//#endregion
//#region lib/types/subagents.js
/**
* The nine host handlers answering the RLM Python runtime's `host_request`
* types. Spawn-style requests drive `ctx.subagents`' continuable manager,
* roster requests fold each child's session cut through `ctx.sessionQuery`,
* model search reads `ctx.llm`, and background-command completions steer a
* notice into the owning session. Handler errors become error replies, so
* every validation message is model-facing text.
*
* @module @deepseek-ai/dsh-rlm-bindings/subagents
*/
/** Hard cap for labels carried into roster rows. */
const RLM_REGISTRY_LABEL_MAX_LENGTH = 200;
/** Interval between observation rounds while `rlm.collect` waits. */
const COLLECT_POLL_INTERVAL_MS = 100;
/** Resolve the route a spawn runs on: the requested selector, or the parent's. */
function resolveRoute(requested, agent, operation) {
	if (requested !== void 0) {
		const route = splitModelSelector(requested, operation);
		return {
			selector: requested,
			provider: route.provider,
			model: route.model
		};
	}
	const provider = agent.options.provider;
	const model = agent.options.model;
	if (provider === void 0 || model === void 0) throw new Error(`${operation}: no model was given and the parent session has no provider/model route to inherit`);
	return { selector: `${provider}/${model}` };
}
/** Read one child's session cut and fold its facts, disposing the lease. */
async function observeFacts(deps, childId, signal) {
	const observation = await deps.observations.observeSession(SessionId(childId), {
		signal,
		projectionMode: "all"
	});
	try {
		return foldChildFacts(observation.events, observation.projections?.values.subagentTiming);
	} finally {
		observation[Symbol.dispose]();
	}
}
/** Snapshot every direct child of the calling parent, catalog order. */
async function snapshotChildren(deps, agent, signal) {
	const parent = String(agent.id);
	const catalog = await deps.subagents.listChildren(agent.id, signal);
	const snapshots = [];
	for (const child of catalog) {
		const childId = String(child.id);
		const facts = await observeFacts(deps, childId, signal);
		const entry = deps.roster.entry(parent, childId);
		const name = entry?.name ?? child.label ?? createDefaultChildName("", childId);
		if (facts.running && facts.lastActivityAt !== void 0) deps.roster.observeActivity(childId, facts.lastActivityAt, performance.now());
		const progressNote = deps.roster.progressNote(childId);
		const activityStaleMs = rlmActivityStaleMs(facts.running, facts.lastActivityAt, deps.roster.activityMonotonicAt(childId));
		snapshots.push({
			childId,
			name,
			sessionDir: deps.sessionDir(childId),
			label: (entry?.label ?? name).slice(0, RLM_REGISTRY_LABEL_MAX_LENGTH),
			...progressNote === void 0 ? {} : { progressNote },
			...activityStaleMs === void 0 ? {} : { activityStaleMs },
			facts
		});
	}
	return snapshots;
}
/** The `rlm.list_subagents` status of one snapshot. */
function rowStatus(facts) {
	if (facts.running) return "running";
	if (facts.lastTurnCompleted === true) return "completed";
	if (facts.lastTurnCompleted === false) return "error";
	return "running";
}
/** Project one snapshot onto an `rlm.list_subagents` row. */
function toSubagentRow(snapshot) {
	const facts = snapshot.facts;
	return {
		rlm_child_id: snapshot.childId,
		active_session_id: snapshot.childId,
		session_id: snapshot.childId,
		session_name: snapshot.name,
		session_dir: snapshot.sessionDir,
		status: rowStatus(facts),
		...facts.toolUseCount === void 0 ? {} : { tool_use_count: facts.toolUseCount },
		...facts.durationMs === void 0 ? {} : { duration_ms: facts.durationMs },
		...facts.answerPreview === void 0 ? {} : { answer_preview: facts.answerPreview },
		...facts.repliedSinceTask === void 0 ? {} : { replied_since_task: facts.repliedSinceTask },
		...snapshot.progressNote === void 0 ? {} : { progress_note: snapshot.progressNote },
		label: snapshot.label,
		...facts.lastActivityAt === void 0 ? {} : { last_activity_at: facts.lastActivityAt },
		...snapshot.activityStaleMs === void 0 ? {} : { activity_stale_ms: snapshot.activityStaleMs }
	};
}
/** The `rlm.collect` status of one snapshot, with its settled flag. */
function collectStatus(facts) {
	if (facts.running) return {
		status: "running",
		settled: false
	};
	if (facts.lastTurnCompleted === true) return {
		status: "done",
		settled: true
	};
	if (facts.lastTurnCompleted === false) return {
		status: "error",
		settled: true
	};
	return {
		status: "queued",
		settled: false
	};
}
/** Project one snapshot onto an `rlm.collect` result entry. */
function toCollectRow(snapshot) {
	const facts = snapshot.facts;
	const { status, settled } = collectStatus(facts);
	return {
		rlm_child_id: snapshot.childId,
		session_name: snapshot.name,
		session_dir: snapshot.sessionDir,
		status,
		settled,
		...facts.answerPreview === void 0 ? {} : { answer_preview: facts.answerPreview },
		...facts.error === void 0 ? {} : { error: facts.error },
		...facts.durationMs === void 0 ? {} : { duration_ms: facts.durationMs },
		...facts.toolUseCount === void 0 ? {} : { tool_use_count: facts.toolUseCount },
		...facts.repliedSinceTask === void 0 ? {} : { replied_since_task: facts.repliedSinceTask }
	};
}
/** Select the one snapshot a delete target names, with the subagent error vocabulary. */
function selectOneSnapshot(snapshots, target) {
	const [first, second] = snapshots.filter((snapshot) => snapshot.childId === target || snapshot.name === target);
	if (first === void 0) throw new Error(`No direct RLM subagent matches "${target}" in the current parent session`);
	if (second !== void 0) throw new Error(`RLM subagent selector "${target}" is ambiguous in the current parent session`);
	return first;
}
/** Select the snapshots a target list names, or every one for an empty list. */
function selectSnapshots(snapshots, targets) {
	if (targets.length === 0) return [...snapshots];
	const selected = [];
	for (const target of targets) {
		const [first, second] = snapshots.filter((snapshot) => snapshot.childId === target || snapshot.name === target);
		if (first === void 0) throw new Error(`No direct RLM child matches "${target}" in the current parent session`);
		if (second !== void 0) throw new Error(`RLM child selector "${target}" is ambiguous in the current parent session`);
		selected.push(first);
	}
	return selected;
}
/** Sleep one collect poll round. */
function delay(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}
/** Shared spawn path behind `rlm.run` and `rlm.create_session`. */
async function runSpawn(deps, request, context, operation) {
	const prompt = stringField(request.data, "prompt", `${operation} prompt must be a string`);
	const kwargs = kwargsField(request.data);
	let name = normalizeRequestedName(kwargs["name"], operation);
	const requestedModel = normalizeRequestedModel(kwargs["model"], operation);
	const thinking = normalizeRequestedThinking(kwargs["thinking"], operation);
	let mintedId;
	if (operation === "rlm.create_session") {
		if (kwargs["cwd"] !== void 0) throw new Error("rlm.create_session: the cwd kwarg is not supported by this host");
		mintedId = SessionId(randomUUID());
		name ??= createDefaultChildName(prompt, String(mintedId));
	}
	if (name === void 0) throw new Error("rlm.spawn name is required");
	const route = resolveRoute(requestedModel, context.agent, operation);
	const agentOptions = {
		...route.provider === void 0 ? {} : { provider: route.provider },
		...route.model === void 0 ? {} : { model: route.model },
		...thinking === void 0 ? {} : { reasoningEffort: ReasoningEffortId(thinking) }
	};
	const parent = String(context.agent.id);
	const release = deps.roster.reserve(parent, name, operation);
	let start;
	try {
		start = await deps.subagents.startContinuable({
			provider: deps.providerName,
			label: name,
			...mintedId === void 0 ? {} : { childId: mintedId },
			request: {
				prompt: [{
					type: "text",
					text: prompt
				}],
				parent: context.agent,
				...Object.keys(agentOptions).length === 0 ? {} : { agentOptions }
			},
			signal: context.signal
		});
	} catch (error) {
		release();
		throw error;
	}
	const childId = String(start.childId);
	deps.roster.admit(parent, {
		childId,
		name,
		model: route.selector,
		label: rlmChildLabel(prompt),
		createdAt: Date.now()
	});
	if (operation === "rlm.create_session") return ok({
		active_session_id: childId,
		session_id: childId,
		name,
		session_file: deps.sessionDir(childId),
		model: route.selector
	});
	return ok({
		rlm_child_id: childId,
		name,
		session_dir: deps.sessionDir(childId),
		model: route.selector
	});
}
/** Answer `rlm.collect`: a bounded wait over selected children, never a timeout error. */
async function runCollect(deps, request, context) {
	const targets = collectTargetsField(request.data);
	const timeoutMs = collectTimeoutField(request.data);
	const selected = selectSnapshots(await snapshotChildren(deps, context.agent, context.signal), targets);
	if (timeoutMs > 0) {
		const deadline = Date.now() + timeoutMs;
		while (!context.signal.aborted) {
			const pending = selected.filter((snapshot) => !collectStatus(snapshot.facts).settled);
			if (pending.length === 0) break;
			const remaining = deadline - Date.now();
			if (remaining <= 0) break;
			await delay(Math.min(COLLECT_POLL_INTERVAL_MS, remaining));
			for (const snapshot of pending) snapshot.facts = await observeFacts(deps, snapshot.childId, context.signal);
		}
	}
	return ok({ results: selected.map(toCollectRow) });
}
/** Answer `rlm.delete_subagent`: drain one settled child, skip a running one. */
async function runDelete(deps, request, context) {
	const target = deleteTargetField(request.data);
	const row = toSubagentRow(selectOneSnapshot(await snapshotChildren(deps, context.agent, context.signal), target));
	if (row.status === "running") return ok({
		subagent: row,
		outcome: "skipped_running"
	});
	await deps.subagents.drainContinuableChildren(context.agent, [SessionId(row.rlm_child_id)]);
	deps.roster.forget(String(context.agent.id), row.rlm_child_id);
	return ok({ subagent: row });
}
/**
* Assemble the nine host handlers the bindings answer.
*
* @param deps - the composition services captured at load.
* @returns the handler map to register on `ctx.rlmKernel`.
*/
function createRlmHostHandlers(deps) {
	return {
		"rlm.run": (request, context) => runSpawn(deps, request, context, "rlm.spawn"),
		"rlm.create_session": (request, context) => runSpawn(deps, request, context, "rlm.create_session"),
		"rlm.find_models": async (request) => {
			const { query, limit } = findModelsRequest(request.data);
			return ok({ models: await findRlmModels(deps.models, query, limit) });
		},
		"rlm.list_subagents": async (_request, context) => {
			return ok({ subagents: (await snapshotChildren(deps, context.agent, context.signal)).map(toSubagentRow) });
		},
		"rlm.collect": (request, context) => runCollect(deps, request, context),
		"rlm.progress.note": (request, context) => {
			const message = progressNoteMessage(request.data);
			const result = deps.roster.noteProgress(String(context.agent.id), message, Date.now());
			if (result === void 0) throw new Error("rlm.progress.note: this session is not a registered RLM child");
			return Promise.resolve(ok(result.accepted ? { accepted: true } : {
				accepted: false,
				retry_after_ms: result.retryAfterMs
			}));
		},
		"rlm.delete_subagent": (request, context) => runDelete(deps, request, context),
		"bash.completed": (request, context) => {
			const details = bashCompletionField(request.data);
			const message = createBashCompletionMessage(details);
			context.agent.steer(message);
			deps.notices.record(String(context.agent.id), details.pid, details.command, message.id);
			return Promise.resolve(ok({}));
		},
		"bash.consumed": (request, context) => {
			const details = bashConsumedField(request.data);
			const messageId = deps.notices.takeEarliest(String(context.agent.id), details.pid, details.command);
			if (messageId !== void 0) context.agent.inbox.remove(messageId);
			return Promise.resolve(ok({}));
		}
	};
}
//#endregion
//#region lib/types/index.js
/**
* Host bindings answering the RLM Python runtime's `host_request` types: child
* spawning and fan-in through `ctx.subagents`, model search through `ctx.llm`,
* session goals through `ctx.goals`, deferred compaction through
* `ctx.compaction` and `ctx.tokenMeter`, family messaging and observation
* through `ctx.agents`, continual-harness refinement scheduling, and internal
* heartbeats persisted under the DSH home. The handlers mount on
* `ctx.rlmKernel` once per composition and read the calling agent off each
* request's context, so one registration serves every session's kernel.
*
* @module @deepseek-ai/dsh-rlm-bindings
*/
const name = "rlm-bindings";
const inject = [
	"rlmKernel",
	"subagents",
	"llm",
	"sessionQuery",
	"agents",
	"goals",
	"tokenMeter"
];
/** Validated plugin configuration for the RLM host bindings. */
const Config = z.object({
	providerName: z.string().default("spawn"),
	dshHome: z.string().default(""),
	mcpServersFile: z.string().default("")
});
/**
* Register the host-request handlers on the kernel service.
*
* The roster the handlers share lives for the composition's lifetime; the
* registration itself is withdrawn when the plugin's fiber disposes. The
* heartbeat table persists under the DSH home, so a restart resumes the
* stored beats; refinement requests stay process-local and die with it.
*
* @param ctx - the Cordis context this plugin registers into.
* @param config - validated configuration with the spawn provider name.
*/
function apply(ctx, config = {}) {
	const providerName = config.providerName ?? "spawn";
	const dshHome = config.dshHome === void 0 || config.dshHome.trim().length === 0 ? void 0 : config.dshHome;
	const observations = ctx.sessionQuery;
	const scopedCompaction = { compactNow: (agent, signal) => {
		const live = ctx.agents.get(agent.session.header.id);
		if (live === void 0) return Promise.reject(/* @__PURE__ */ new Error("the calling agent is not live in this host"));
		const engine = live.ctx.get("compaction") ?? ctx.get("agentPresets")?.serviceFor(live, "compaction");
		if (engine === void 0) return Promise.reject(/* @__PURE__ */ new Error("no compaction engine is mounted in the calling agent's scope"));
		return engine.compactNow(agent, signal);
	} };
	const roster = new Roster();
	const requests = new RefineRequests();
	const scheduler = new HeartbeatScheduler({
		store: new HeartbeatStore(join(resolveDshHome(dshHome), "rlm", "heartbeats.json")),
		resolveAgent: (id) => ctx.agents.get(SessionId(id)) ?? void 0,
		onError: (error) => {
			ctx.logger("rlm-bindings").warn("heartbeat delivery failed: %s", error);
		}
	});
	scheduler.start();
	const withdraw = ctx.rlmKernel.registerHostRequestHandlers({
		...createRlmHostHandlers({
			subagents: ctx.subagents,
			models: ctx.llm,
			observations,
			roster,
			providerName,
			sessionDir: (childId) => join(resolveDshHome(dshHome), "rlm", "children", childId),
			notices: new BashNoticeBoard()
		}),
		...createGoalHostHandlers({ goals: ctx.goals }),
		...createCompactHostHandlers({
			compaction: scopedCompaction,
			usage: ctx.tokenMeter,
			models: ctx.llm
		}),
		...createModelInfoHostHandlers({ models: ctx.llm }),
		...createMcpHostHandlers({ servers: () => readMcpServersFile(config.mcpServersFile === void 0 || config.mcpServersFile.trim().length === 0 ? join(resolveDshHome(dshHome), "mcp-servers.json") : config.mcpServersFile) }),
		...createAgentMessageHostHandlers({
			agents: ctx.agents,
			subagents: ctx.subagents,
			roster
		}),
		...createAgentObserveHostHandlers({
			agents: ctx.agents,
			subagents: ctx.subagents,
			roster,
			observations
		}),
		...createHeartbeatHostHandlers({ heartbeats: scheduler }),
		...createRefineHostHandlers({ requests })
	});
	ctx.on("agent/turn-stopping", createRefineTurnStopping({ requests }));
	ctx.on("agent/disposed", ({ agent }) => {
		requests.forget(String(agent.id));
		scheduler.cancelSession(String(agent.id));
	});
	ctx.effect(() => () => {
		scheduler.dispose();
		withdraw();
	});
}
//#endregion
export { Config, apply, inject, name };
