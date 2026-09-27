/**
 * Wire constants and inbound validation for the persistent Python REPL
 * protocol. The child process is a foreign subprocess that can send anything,
 * so every frame is rebuilt field by field before a consumer reads it.
 *
 * @module @deepseek-ai/dsh-rlm-kernel/protocol
 */
import type { RlmWireEvent } from './types.ts';
/** Protocol version this host speaks; the child announces the same value in `ready`. */
export declare const RLM_PROTOCOL_VERSION = 3;
/** Python versions the kernel providers support. */
export declare const RLM_MINIMUM_PYTHON_MAJOR = 3;
/** Lowest supported Python minor version, against {@link RLM_MINIMUM_PYTHON_MAJOR}. */
export declare const RLM_MINIMUM_PYTHON_MINOR = 10;
/** One JSON object per line; no other framing exists on the wire. */
export declare const RLM_FRAME_SEPARATOR = "\n";
/**
 * Rebuild one parsed line as a validated event.
 *
 * A forged frame never rides along: every field is read through its own type
 * check, and any line that fails one returns `undefined` so the caller drops
 * it instead of acting on attacker-chosen content.
 *
 * @param line - one non-empty line of the child's stdout.
 * @returns the rebuilt event, or `undefined` when the line is not a valid event.
 */
export declare function parseRlmEvent(line: string): RlmWireEvent | undefined;
/**
 * Rebuild one already-parsed frame as a validated event.
 *
 * @param frame - the parsed JSON value of one wire line.
 * @returns the rebuilt event, or `undefined` when the frame is not a valid event.
 */
export declare function rebuildEvent(frame: unknown): RlmWireEvent | undefined;
/**
 * Encode one request as the child expects to read it.
 *
 * @param request - the request to serialize.
 * @returns the request as one JSON line, terminated by the frame separator.
 */
export declare function encodeRlmRequest(request: object): string;
//# sourceMappingURL=protocol.d.ts.map