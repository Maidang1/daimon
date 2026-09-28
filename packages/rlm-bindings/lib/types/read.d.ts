/**
 * Wire-payload readers, reply constructors, and request normalizers for the
 * RLM host bindings. A reader throws an `Error` whose message matches the
 * reference host implementation, because the kernel turns a thrown handler
 * into the error reply the model reads verbatim.
 *
 * @module @deepseek-ai/dsh-rlm-bindings/read
 */
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type { RlmHostReplyOk } from '@deepseek-ai/dsh-rlm-kernel';
/** Hard cap for a requested child session name, in UTF-16 code units. */
export declare const RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH = 64;
/** Default number of model matches one `rlm.find_models` call returns. */
export declare const DEFAULT_RLM_MODEL_SEARCH_LIMIT = 8;
/** Largest `limit` one `rlm.find_models` call accepts. */
export declare const MAX_RLM_MODEL_SEARCH_LIMIT = 20;
/** Hard cap for one child progress note, in UTF-16 code units. */
export declare const RLM_PROGRESS_NOTE_MAX_LENGTH = 512;
/**
 * Wrap one handler result as the success reply the runtime unwraps.
 *
 * @param result - the reply payload the requesting cell receives.
 * @returns the `ok` reply frame for the kernel.
 */
export declare function ok(result: JsonValue): RlmHostReplyOk;
/**
 * True for a plain object payload member, never for an array or `null`.
 *
 * @param value - the payload member under test.
 * @returns whether the member is a string-keyed record.
 */
export declare function isRecord(value: unknown): value is Record<string, unknown>;
/**
 * Read one required string member of a request payload.
 *
 * @param data - the `host_request` payload.
 * @param key - the member to read.
 * @param message - the error message a non-string member raises.
 * @returns the member's string value.
 */
export declare function stringField(data: Readonly<Record<string, unknown>>, key: string, message: string): string;
/**
 * Read the `kwargs` member of a spawn-style payload, tolerating a missing or
 * malformed member as no kwargs at all.
 *
 * @param data - the `host_request` payload.
 * @returns the kwargs record, or an empty one.
 */
export declare function kwargsField(data: Readonly<Record<string, unknown>>): Record<string, unknown>;
/**
 * Normalize a requested child session name, or `undefined` when omitted.
 *
 * @param value - the raw `name` kwarg.
 * @param operation - the wire type the error messages name.
 * @returns the trimmed name.
 */
export declare function normalizeRequestedName(value: unknown, operation: string): string | undefined;
/**
 * Normalize a requested `provider/model` selector, or `undefined` when omitted.
 *
 * @param value - the raw `model` kwarg.
 * @param operation - the wire type the error messages name.
 * @returns the trimmed selector.
 */
export declare function normalizeRequestedModel(value: unknown, operation: string): string | undefined;
/**
 * Normalize a requested reasoning effort, or `undefined` when omitted. The
 * effort vocabulary is adapter-owned, so the bindings check only the shape.
 *
 * @param value - the raw `thinking` kwarg.
 * @param operation - the wire type the error messages name.
 * @returns the trimmed effort id.
 */
export declare function normalizeRequestedThinking(value: unknown, operation: string): string | undefined;
/**
 * Split a normalized `provider/model` selector into its route parts.
 *
 * @param selector - the normalized selector.
 * @param operation - the wire type the error message names.
 * @returns the provider route and the model id.
 */
export declare function splitModelSelector(selector: string, operation: string): {
    provider: string;
    model: string;
};
/**
 * Create a readable, collision-resistant default child name from the initial
 * prompt and the minted child id.
 *
 * @param prompt - the child's initial prompt.
 * @param childId - the minted child session id.
 * @returns a name unique enough to select the child by.
 */
export declare function createDefaultChildName(prompt: string, childId: string): string;
/**
 * Collapse one text to a single line capped at `maxLength` characters, for
 * answer previews and labels carried into roster rows.
 *
 * @param text - the source text.
 * @param maxLength - the cap, in UTF-16 code units.
 * @returns the compacted text, ellipsized when capped.
 */
export declare function compactRlmText(text: string, maxLength?: number): string;
/**
 * Collapse a child's initial prompt to its one-line roster label, keeping the
 * full length so a client can elide shared prefixes itself.
 *
 * @param prompt - the child's initial prompt.
 * @returns the one-line label.
 */
export declare function rlmChildLabel(prompt: string): string;
/** Validated `rlm.find_models` arguments. */
export interface FindModelsRequest {
    /** Search text matched against selector, id, and name. */
    readonly query: string;
    /** Maximum number of matches returned. */
    readonly limit: number;
}
/**
 * Read the arguments of one `rlm.find_models` payload.
 *
 * @param data - the `host_request` payload.
 * @returns the validated query and limit.
 */
export declare function findModelsRequest(data: Readonly<Record<string, unknown>>): FindModelsRequest;
/**
 * Read and normalize the `targets` member of one `rlm.collect` payload.
 *
 * @param data - the `host_request` payload.
 * @returns the trimmed target selectors, empty when omitted.
 */
export declare function collectTargetsField(data: Readonly<Record<string, unknown>>): string[];
/**
 * Read the `timeout_ms` member of one `rlm.collect` payload.
 *
 * @param data - the `host_request` payload.
 * @returns the bounded wait in milliseconds, `0` when omitted.
 */
export declare function collectTimeoutField(data: Readonly<Record<string, unknown>>): number;
/**
 * Read and normalize the `message` member of one `rlm.progress.note` payload.
 *
 * @param data - the `host_request` payload.
 * @returns the trimmed progress note.
 */
export declare function progressNoteMessage(data: Readonly<Record<string, unknown>>): string;
/**
 * Read and normalize the `target` member of one `rlm.delete_subagent` payload.
 *
 * @param data - the `host_request` payload.
 * @returns the trimmed target selector.
 */
export declare function deleteTargetField(data: Readonly<Record<string, unknown>>): string;
/** Validated `bash.completed` notification. */
export interface BashCompletion {
    /** Process id of the finished command. */
    readonly pid: number;
    /** The command line that finished. */
    readonly command: string;
    /** The process exit code. */
    readonly exitCode: number;
}
/**
 * Read one `bash.completed` notification payload.
 *
 * @param data - the `host_request` payload.
 * @returns the validated completion.
 */
export declare function bashCompletionField(data: Readonly<Record<string, unknown>>): BashCompletion;
/**
 * Read one `bash.consumed` notification payload.
 *
 * @param data - the `host_request` payload.
 * @returns the validated pid and command.
 */
export declare function bashConsumedField(data: Readonly<Record<string, unknown>>): {
    pid: number;
    command: string;
};
//# sourceMappingURL=read.d.ts.map