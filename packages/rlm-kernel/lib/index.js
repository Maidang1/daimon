import { Service } from "@deepseek-ai/cordis";
import { isJsonValue } from "@deepseek-ai/dsh-util-values";
//#region lib/types/error.js
/**
* Kernel failure type shared by every provider of the `ctx.rlmKernel` seam.
*
* @module @deepseek-ai/dsh-rlm-kernel/error
*/
/** Failure raised when a kernel cannot serve a request. */
var RlmKernelError = class extends Error {
	/**
	* @param message - description of the failure.
	* @param options - error options carrying the originating cause.
	*/
	constructor(message, options) {
		super(message, options);
		this.name = "RlmKernelError";
	}
};
//#endregion
//#region lib/types/protocol.js
/**
* Wire constants and inbound validation for the persistent Python REPL
* protocol. The child process is a foreign subprocess that can send anything,
* so every frame is rebuilt field by field before a consumer reads it.
*
* @module @deepseek-ai/dsh-rlm-kernel/protocol
*/
/** Protocol version this host speaks; the child announces the same value in `ready`. */
const RLM_PROTOCOL_VERSION = 3;
/** Python versions the kernel providers support. */
const RLM_MINIMUM_PYTHON_MAJOR = 3;
/** Lowest supported Python minor version, against {@link RLM_MINIMUM_PYTHON_MAJOR}. */
const RLM_MINIMUM_PYTHON_MINOR = 10;
/** One JSON object per line; no other framing exists on the wire. */
const RLM_FRAME_SEPARATOR = "\n";
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
function parseRlmEvent(line) {
	let parsed;
	try {
		parsed = JSON.parse(line);
	} catch {
		return;
	}
	return rebuildEvent(parsed);
}
/**
* Rebuild one already-parsed frame as a validated event.
*
* @param frame - the parsed JSON value of one wire line.
* @returns the rebuilt event, or `undefined` when the frame is not a valid event.
*/
function rebuildEvent(frame) {
	if (typeof frame !== "object" || frame === null) return void 0;
	const tag = frame.event;
	switch (tag) {
		case "ready": return rebuildReady(frame);
		case "stdout":
		case "stderr": return rebuildOutput(frame, tag);
		case "result": return rebuildResult(frame);
		case "display": return rebuildDisplay(frame);
		case "host_request": return rebuildHostRequest(frame);
		case "error": return rebuildError(frame);
		case "done": return rebuildDone(frame);
		default: return;
	}
}
/**
* Encode one request as the child expects to read it.
*
* @param request - the request to serialize.
* @returns the request as one JSON line, terminated by the frame separator.
*/
function encodeRlmRequest(request) {
	return `${JSON.stringify(request)}
`;
}
/**
* Narrow one parsed wire field to a JSON object whose members are JSON values.
*
* @param value - the parsed field, whose member types are unverified.
* @returns the object when every member survives a lossless JSON check, otherwise `undefined`.
*/
function jsonObject(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	if (!isJsonValue(value)) return void 0;
	return value;
}
/**
* Narrow one parsed wire field to a string array.
*
* @param value - the parsed field, whose element types are unverified.
* @returns the elements when every one is a string, otherwise `undefined`.
*/
function stringList(value) {
	if (!Array.isArray(value)) return void 0;
	const names = [];
	for (const name of value) {
		if (typeof name !== "string") return void 0;
		names.push(name);
	}
	return names;
}
function rebuildReady(frame) {
	const { protocol, python } = frame;
	if (typeof protocol !== "number" || typeof python !== "string") return void 0;
	return {
		event: "ready",
		protocol,
		python
	};
}
function rebuildOutput(frame, event) {
	const { id, text } = frame;
	if (typeof text !== "string") return void 0;
	const cellId = id === null ? null : typeof id === "string" ? id : void 0;
	if (cellId === void 0) return void 0;
	return {
		event,
		id: cellId,
		text
	};
}
function rebuildResult(frame) {
	const { id, text } = frame;
	if (typeof id !== "string" || typeof text !== "string") return void 0;
	return {
		event: "result",
		id,
		text
	};
}
function rebuildDisplay(frame) {
	const { id, data } = frame;
	const payload = jsonObject(data);
	if (payload === void 0) return void 0;
	const cellId = id === null ? null : typeof id === "string" ? id : void 0;
	if (cellId === void 0) return void 0;
	return {
		event: "display",
		id: cellId,
		data: payload
	};
}
function rebuildHostRequest(frame) {
	const { id, data } = frame;
	if (typeof id !== "string") return void 0;
	const payload = jsonObject(data);
	if (payload === void 0) return void 0;
	return {
		event: "host_request",
		id,
		data: payload
	};
}
function rebuildError(frame) {
	const { id, ename, evalue, traceback } = frame;
	if (typeof ename !== "string" || typeof evalue !== "string") return void 0;
	const frames = stringList(traceback);
	if (frames === void 0) return void 0;
	const cellId = id === null ? null : typeof id === "string" ? id : void 0;
	if (cellId === void 0) return void 0;
	return {
		event: "error",
		id: cellId,
		ename,
		evalue,
		traceback: frames
	};
}
function rebuildDone(frame) {
	const { id, status, reason, bytes } = frame;
	if (typeof id !== "string") return void 0;
	if (status !== "ok" && status !== "error") return void 0;
	const done = {
		event: "done",
		id,
		status
	};
	if (typeof reason === "string") done.reason = reason;
	for (const key of [
		"saved",
		"skipped",
		"pruned",
		"restored",
		"failed",
		"names"
	]) {
		const names = stringList(frame[key]);
		if (names !== void 0) done[key] = names;
	}
	if (typeof bytes === "number") done.bytes = bytes;
	return done;
}
//#endregion
//#region lib/types/index.js
/**
* Service Definition for the `ctx.rlmKernel` capability seam: one persistent
* Python REPL per agent session. A consumer asks for the kernel of a session
* and receives a handle that runs code cells, interrupts them, and snapshots
* the namespace; the provider owns the process, the wire protocol, and the
* interpreter.
*
* @module @deepseek-ai/dsh-rlm-kernel
*/
/**
* Persistent-kernel registry for agent sessions.
*
* A kernel owns one interpreter process and the namespace that survives across
* cells, so a session's handle is created lazily on first use and stays alive
* until {@link release} or the composition that acquired it is disposed. One
* provider registers per context; loading a second throws, which is Cordis'
* standard duplicate-service behavior.
*
* Implementations must honor these semantics:
* - {@link acquire} returns the same handle for repeated calls on one session,
*   unless {@link release} ran in between.
* - {@link RlmKernelHandle.execute} resolves after the cell's `done` event, so
*   every event the cell produced has already been delivered.
* - A handle rejects further work after {@link RlmKernelHandle.dispose}.
* - {@link release} is idempotent and never rejects for an unknown session.
*/
var RlmKernel = class extends Service {
	/** Handler maps mounted by other plugins, oldest first. */
	hostRequestRegistrations = [];
	constructor(ctx) {
		super(ctx, "rlmKernel");
	}
	/**
	* Answer `host_request` events from every kernel this service owns, without
	* each consumer having to pass handlers to {@link acquire}.
	*
	* A binding plugin registers once per composition and reads the calling
	* agent off {@link RlmHostRequestContext}; the returned disposer withdraws
	* exactly that map, so a plugin's own fiber disposal withdraws its bindings.
	* Handlers passed to {@link acquire} win over registered ones for the same
	* request type, which keeps one consumer able to specialize a session.
	*
	* @param handlers - handlers keyed by the `type` field of a `host_request` payload.
	* @returns a disposer that withdraws this registration.
	*/
	registerHostRequestHandlers(handlers) {
		this.hostRequestRegistrations.push(handlers);
		let withdrawn = false;
		return () => {
			if (withdrawn) return;
			withdrawn = true;
			const index = this.hostRequestRegistrations.indexOf(handlers);
			if (index !== -1) this.hostRequestRegistrations.splice(index, 1);
		};
	}
	/**
	* Resolve the handler answering one request type, per-acquire handlers first.
	*
	* @param own - handlers the acquiring consumer passed, if any.
	* @param type - the `type` field of the `host_request` payload.
	* @returns the first handler that claims the type, or `undefined` for none.
	*/
	hostRequestHandler(own, type) {
		const ownHandler = own?.[type];
		if (ownHandler !== void 0) return ownHandler;
		for (const handlers of this.hostRequestRegistrations) {
			const handler = handlers[type];
			if (handler !== void 0) return handler;
		}
	}
};
//#endregion
export { RLM_FRAME_SEPARATOR, RLM_MINIMUM_PYTHON_MAJOR, RLM_MINIMUM_PYTHON_MINOR, RLM_PROTOCOL_VERSION, RlmKernel, RlmKernel as default, RlmKernelError, encodeRlmRequest, parseRlmEvent, rebuildEvent };
