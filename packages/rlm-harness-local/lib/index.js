import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { DEFAULT_HARNESS_PATH, DEFAULT_HARNESS_SOURCE, HARNESS_KINDS, HarnessRefiner, HarnessStateError, applyRefinement, emptyHarnessState, normalizeEntry, rollbackToEvent, withEntry } from "@deepseek-ai/dsh-rlm-harness";
//#region lib/types/store.js
/**
* JSON file persistence for the Local harness refiner: one
* `harness_state.json` per scope under the RLM root of the DSH home. The
* on-disk shape mirrors the reference host's — a `schema` version, entries
* grouped by kind and then by id, and the refinement history in application
* order — so a state file remains readable by hand and replayable by tooling.
* Loading is total: a missing, unreadable, or corrupt file reads as the empty
* state, and every stored record is revalidated field by field, because the
* file is shared with writers outside this process and must never crash a
* session that only reads it.
*
* @module @deepseek-ai/dsh-rlm-harness-local/store
*/
/** Directory under the DSH home that groups every RLM-owned file. */
const RLM_DIR_NAME = "rlm";
/** Directory under the RLM root that holds the harness stores. */
const HARNESS_STATE_DIR_NAME = "harness";
/** File name of one scope's harness store. */
const HARNESS_STATE_FILE_NAME = "harness_state.json";
/** On-disk schema version written with every save. */
const HARNESS_STATE_SCHEMA = 1;
/** Permission bits stamped on a freshly created state file. */
const HARNESS_STATE_FILE_MODE = 384;
/** Permission bits stamped on directories a save creates. */
const HARNESS_STATE_DIR_MODE = 448;
/** Re-interpret a parsed JSON value as a record, or decline every other shape. */
function jsonRecord(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	return value;
}
/**
* Absolute path of the machine-wide harness store under one DSH home.
*
* @param home - resolved DSH home directory.
* @returns the global store's state file path.
*/
function globalHarnessStatePath(home) {
	return join(home, "rlm", HARNESS_STATE_DIR_NAME, HARNESS_STATE_FILE_NAME);
}
/**
* Absolute path of one session's harness store under one DSH home.
*
* @param home - resolved DSH home directory.
* @param sessionId - session the store belongs to; must be a single safe path segment.
* @returns the session store's state file path.
* @throws {HarnessStateError} when the id could escape the sessions directory.
*/
function localHarnessStatePath(home, sessionId) {
	if (sessionId === "" || sessionId === "." || sessionId === ".." || sessionId.includes("/") || sessionId.includes("\\")) throw new HarnessStateError(`harness session id ${JSON.stringify(sessionId)} is not a safe path segment`);
	return join(home, "rlm", HARNESS_STATE_DIR_NAME, "sessions", sessionId, HARNESS_STATE_FILE_NAME);
}
/**
* Absolute path of the store one scope reference addresses.
*
* @param home - resolved DSH home directory.
* @param scope - the session the state belongs to, or the global store when omitted.
* @returns the addressed store's state file path.
*/
function harnessStatePath(home, scope) {
	return scope?.sessionId === void 0 ? globalHarnessStatePath(home) : localHarnessStatePath(home, scope.sessionId);
}
/**
* The scope a store file holds, derived the same way {@link harnessStatePath} routes.
*
* @param scope - the scope reference a call addressed.
* @returns `local` for a session store, `global` for the machine-wide store.
*/
function harnessStoreScope(scope) {
	return scope?.sessionId === void 0 ? "global" : "local";
}
/**
* Revalidate one stored entry, migrating the shapes earlier writers used.
*
* @param id - identity the entry was filed under.
* @param kind - kind bucket the entry was filed under; wins over the record.
* @param raw - the parsed record.
* @param scope - scope of the store being loaded, the fallback authorship scope.
* @param now - the caller's clock reading, stamping records that carry no timestamps.
* @returns the normalized entry, or `undefined` when the record is unusable.
*/
function loadEntry(id, kind, raw, scope, now) {
	const record = jsonRecord(raw);
	if (record === void 0) return void 0;
	const title = record["title"];
	const content = record["content"];
	if (typeof title !== "string" || typeof content !== "string") return void 0;
	const storedPath = record["path"];
	const storedTopic = record["topic"];
	const storedScope = record["scope"];
	const storedSource = record["source"];
	const storedCreatedAt = record["createdAt"];
	const storedUpdatedAt = record["updatedAt"];
	const storedVersion = record["version"];
	return {
		id,
		kind,
		title,
		content,
		path: typeof storedPath === "string" ? storedPath : typeof storedTopic === "string" ? storedTopic : DEFAULT_HARNESS_PATH,
		scope: storedScope === "local" || storedScope === "global" ? storedScope : scope,
		reference: jsonRecord(record["reference"]) ?? {},
		arguments: jsonRecord(record["arguments"]) ?? {},
		metadata: jsonRecord(record["metadata"]) ?? {},
		source: typeof storedSource === "string" ? storedSource : DEFAULT_HARNESS_SOURCE,
		createdAt: typeof storedCreatedAt === "string" ? storedCreatedAt : now,
		updatedAt: typeof storedUpdatedAt === "string" ? storedUpdatedAt : now,
		version: typeof storedVersion === "number" && Number.isInteger(storedVersion) && storedVersion >= 1 ? storedVersion : 1
	};
}
/**
* Revalidate one stored refinement event.
*
* @param raw - the parsed record.
* @param now - the caller's clock reading, stamping events that carry no timestamp.
* @returns the normalized event, or `undefined` when the record is unusable.
*/
function loadRefinement(raw, now) {
	const record = jsonRecord(raw);
	if (record === void 0) return void 0;
	const id = record["id"];
	const trigger = record["trigger"];
	if (typeof id !== "string" || typeof trigger !== "string") return void 0;
	const storedChanges = record["changes"];
	let changes;
	if (typeof storedChanges === "string") changes = [storedChanges];
	else if (Array.isArray(storedChanges)) changes = storedChanges.filter((change) => typeof change === "string");
	else return;
	const evidence = record["evidence"];
	const outcome = record["outcome"];
	const createdAt = record["createdAt"];
	return {
		id,
		trigger,
		changes,
		evidence: typeof evidence === "string" ? evidence : "",
		outcome: typeof outcome === "string" ? outcome : "",
		createdAt: typeof createdAt === "string" ? createdAt : now
	};
}
/**
* Parse one state file's text into a harness state.
*
* @param text - the file's raw content.
* @param scope - scope of the store being loaded, the fallback entry scope.
* @param now - the caller's clock reading for records without timestamps.
* @returns the parsed state; any unparseable or non-object document reads as empty.
*/
function parseHarnessState(text, scope, now) {
	let document;
	try {
		document = JSON.parse(text);
	} catch {
		return emptyHarnessState();
	}
	const root = jsonRecord(document);
	if (root === void 0) return emptyHarnessState();
	const entries = {};
	for (const kind of HARNESS_KINDS) entries[kind] = {};
	const refinements = [];
	const storedEntries = jsonRecord(root["entries"]);
	if (storedEntries !== void 0) for (const kind of HARNESS_KINDS) {
		const bucket = jsonRecord(storedEntries[kind]);
		if (bucket === void 0) continue;
		for (const [id, raw] of Object.entries(bucket)) {
			const entry = loadEntry(id, kind, raw, scope, now);
			if (entry === void 0) continue;
			entries[kind][entry.id] = entry;
		}
	}
	const storedRefinements = root["refinements"];
	if (Array.isArray(storedRefinements)) for (const raw of storedRefinements) {
		const event = loadRefinement(raw, now);
		if (event === void 0) continue;
		refinements.push(event);
	}
	return {
		entries,
		refinements
	};
}
/**
* Read one store's current state from disk, including writes another process
* made since this service started.
*
* @param filePath - the store's state file path.
* @param scope - scope of the store being loaded, the fallback entry scope.
* @param now - the caller's clock reading for records without timestamps.
* @returns the stored state; a missing or unreadable file reads as empty.
*/
async function loadHarnessState(filePath, scope, now) {
	let text;
	try {
		text = await readFile(filePath, "utf8");
	} catch {
		return emptyHarnessState();
	}
	return parseHarnessState(text, scope, now);
}
/**
* The JSON one save writes for a state.
*
* @param state - the state to persist.
* @returns the complete file content, trailing newline included.
*/
function serializeHarnessState(state) {
	return `${JSON.stringify({
		schema: 1,
		entries: state.entries,
		refinements: state.refinements
	}, null, 2)}\n`;
}
/**
* Persist one state atomically: a same-directory temp file renamed over the
* target, so a concurrent reader observes either the old or the new complete
* content. An existing file keeps its permission bits; a fresh one is created
* owner-only.
*
* @param filePath - the store's state file path.
* @param state - the state to persist.
*/
async function saveHarnessState(filePath, state) {
	const existing = await stat(filePath).catch(() => void 0);
	const mode = existing === void 0 ? 384 : existing.mode & 511;
	await writeFileAtomic(filePath, serializeHarnessState(state), {
		mode,
		dirMode: 448
	});
}
//#endregion
//#region lib/types/index.js
/**
* Service Provider for the `ctx.rlmHarness` capability seam: JSON-file harness
* state under the DSH home. The machine-wide store lives at
* `<dshHome>/rlm/harness/harness_state.json`; each session's local store lives
* at `<dshHome>/rlm/harness/sessions/<sessionId>/harness_state.json`, the same
* local/global split the reference host keeps between its session artifact
* directory and its agent directory. Every write re-reads the file under a
* cross-process writer lock and commits it atomically, so a session and its
* host tools can refine the same store without losing each other's edits.
*
* @module @deepseek-ai/dsh-rlm-harness-local
*/
/**
* Mint the identity of the next refinement event.
*
* The canonical form is the reference host's `refine_<seq>` with a zero-padded
* sequence one past the recorded history. A rollback can free a sequence the
* history still carries under another pass, so a collision bumps the sequence
* until it is free.
*
* @param state - the state the event will be recorded into.
* @returns an identity no recorded refinement carries.
*/
function mintRefinementId(state) {
	const used = new Set(state.refinements.map((event) => event.id));
	let sequence = state.refinements.length + 1;
	for (;;) {
		const id = `refine_${String(sequence).padStart(4, "0")}`;
		if (!used.has(id)) return id;
		sequence += 1;
	}
}
/**
* Default a fresh entry's scope to the store it is written into, the way the
* reference host stamps every upsert with its store's scope. An update that
* omits the scope keeps the stored record's, so an entry never silently moves
* between scopes.
*
* @param input - the entry as the caller supplied it.
* @param scope - scope of the store the entry is written into.
* @param previous - the record being updated, when the write is an update.
* @returns the input with an explicit scope where one is needed.
*/
function withStoreScope(input, scope, previous) {
	return input.scope === void 0 && previous === void 0 ? {
		...input,
		scope
	} : input;
}
/**
* JSON-file provider registering itself as `ctx.rlmHarness`.
*
* The provider is stateless between calls: every method re-reads the
* addressed store from disk, and every mutation serializes its
* read-modify-write through the store file's writer lock, so writes another
* process committed since this service started are never clobbered and the
* seam's "state as of the call" contract holds across processes.
*/
var LocalHarnessRefiner = class extends HarnessRefiner {
	config;
	/** Validated plugin configuration; the home is changeable from `cordis.yml`. */
	static Config = z.object({ dshHome: z.string().default("") });
	/** Resolved DSH home the stores live under. */
	home;
	constructor(ctx, config) {
		super(ctx);
		this.config = config;
		const configured = config.dshHome;
		this.home = resolveDshHome(configured === void 0 || configured.trim().length === 0 ? void 0 : configured);
	}
	/** The caller's clock reading for one write. */
	now() {
		return (/* @__PURE__ */ new Date()).toISOString();
	}
	/**
	* Run one read-modify-write against a store under its writer lock.
	*
	* @param scope - the scope the mutation addresses.
	* @param operation - the mutation, returning the next state and the call's result.
	* @returns the operation's result once the next state is committed.
	*/
	async mutate(scope, operation) {
		const filePath = harnessStatePath(this.home, scope);
		await mkdir(dirname(filePath), {
			recursive: true,
			mode: 448
		});
		return withFileLock(filePath, async () => {
			const now = this.now();
			const mutation = operation(await loadHarnessState(filePath, harnessStoreScope(scope), now), now);
			if (mutation.dirty) await saveHarnessState(filePath, mutation.state);
			return mutation.result;
		});
	}
	async read(scope) {
		return loadHarnessState(harnessStatePath(this.home, scope), harnessStoreScope(scope), this.now());
	}
	async refine(proposal, scope) {
		return this.mutate(scope, (state, now) => {
			const storeScope = harnessStoreScope(scope);
			const scoped = {
				...proposal,
				entries: proposal.entries.map((input) => withStoreScope(input, storeScope, state.entries[input.kind][input.id]))
			};
			const id = mintRefinementId(state);
			const next = applyRefinement(state, scoped, now, id);
			const event = next.refinements.at(-1);
			/* v8 ignore next 3 -- applyRefinement always appends exactly one event */
			if (event === void 0) throw new HarnessStateError("harness refinement recorded no event");
			return {
				state: next,
				result: event,
				dirty: true
			};
		});
	}
	async rollback(eventId, scope) {
		return this.mutate(scope, (state) => {
			const next = rollbackToEvent(state, eventId);
			const removed = state.refinements.length - next.refinements.length;
			return {
				state: next,
				result: removed,
				dirty: removed > 0
			};
		});
	}
	async writeEntry(input, scope) {
		return this.mutate(scope, (state, now) => {
			const previous = state.entries[input.kind][input.id];
			const entry = normalizeEntry(withStoreScope(input, harnessStoreScope(scope), previous), previous, now);
			return {
				state: withEntry(state, entry),
				result: entry,
				dirty: true
			};
		});
	}
	async list(kind, scope) {
		const state = await this.read(scope);
		return (kind === void 0 ? HARNESS_KINDS : [kind]).flatMap((current) => Object.values(state.entries[current]));
	}
};
//#endregion
export { HARNESS_STATE_DIR_MODE, HARNESS_STATE_DIR_NAME, HARNESS_STATE_FILE_MODE, HARNESS_STATE_FILE_NAME, HARNESS_STATE_SCHEMA, LocalHarnessRefiner, LocalHarnessRefiner as default, RLM_DIR_NAME, globalHarnessStatePath, harnessStatePath, harnessStoreScope, loadHarnessState, localHarnessStatePath, parseHarnessState, saveHarnessState, serializeHarnessState };
