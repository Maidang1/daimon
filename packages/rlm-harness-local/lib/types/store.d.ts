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
import type { HarnessScope, HarnessScopeRef, HarnessState } from '@deepseek-ai/dsh-rlm-harness';
/** Directory under the DSH home that groups every RLM-owned file. */
export declare const RLM_DIR_NAME = "rlm";
/** Directory under the RLM root that holds the harness stores. */
export declare const HARNESS_STATE_DIR_NAME = "harness";
/** File name of one scope's harness store. */
export declare const HARNESS_STATE_FILE_NAME = "harness_state.json";
/** On-disk schema version written with every save. */
export declare const HARNESS_STATE_SCHEMA = 1;
/** Permission bits stamped on a freshly created state file. */
export declare const HARNESS_STATE_FILE_MODE = 384;
/** Permission bits stamped on directories a save creates. */
export declare const HARNESS_STATE_DIR_MODE = 448;
/**
 * Absolute path of the machine-wide harness store under one DSH home.
 *
 * @param home - resolved DSH home directory.
 * @returns the global store's state file path.
 */
export declare function globalHarnessStatePath(home: string): string;
/**
 * Absolute path of one session's harness store under one DSH home.
 *
 * @param home - resolved DSH home directory.
 * @param sessionId - session the store belongs to; must be a single safe path segment.
 * @returns the session store's state file path.
 * @throws {HarnessStateError} when the id could escape the sessions directory.
 */
export declare function localHarnessStatePath(home: string, sessionId: string): string;
/**
 * Absolute path of the store one scope reference addresses.
 *
 * @param home - resolved DSH home directory.
 * @param scope - the session the state belongs to, or the global store when omitted.
 * @returns the addressed store's state file path.
 */
export declare function harnessStatePath(home: string, scope?: HarnessScopeRef): string;
/**
 * The scope a store file holds, derived the same way {@link harnessStatePath} routes.
 *
 * @param scope - the scope reference a call addressed.
 * @returns `local` for a session store, `global` for the machine-wide store.
 */
export declare function harnessStoreScope(scope?: HarnessScopeRef): HarnessScope;
/**
 * Parse one state file's text into a harness state.
 *
 * @param text - the file's raw content.
 * @param scope - scope of the store being loaded, the fallback entry scope.
 * @param now - the caller's clock reading for records without timestamps.
 * @returns the parsed state; any unparseable or non-object document reads as empty.
 */
export declare function parseHarnessState(text: string, scope: HarnessScope, now: string): HarnessState;
/**
 * Read one store's current state from disk, including writes another process
 * made since this service started.
 *
 * @param filePath - the store's state file path.
 * @param scope - scope of the store being loaded, the fallback entry scope.
 * @param now - the caller's clock reading for records without timestamps.
 * @returns the stored state; a missing or unreadable file reads as empty.
 */
export declare function loadHarnessState(filePath: string, scope: HarnessScope, now: string): Promise<HarnessState>;
/**
 * The JSON one save writes for a state.
 *
 * @param state - the state to persist.
 * @returns the complete file content, trailing newline included.
 */
export declare function serializeHarnessState(state: HarnessState): string;
/**
 * Persist one state atomically: a same-directory temp file renamed over the
 * target, so a concurrent reader observes either the old or the new complete
 * content. An existing file keeps its permission bits; a fresh one is created
 * owner-only.
 *
 * @param filePath - the store's state file path.
 * @param state - the state to persist.
 */
export declare function saveHarnessState(filePath: string, state: HarnessState): Promise<void>;
//# sourceMappingURL=store.d.ts.map