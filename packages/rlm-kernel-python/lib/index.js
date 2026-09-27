import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
import { RLM_MINIMUM_PYTHON_MAJOR, RLM_MINIMUM_PYTHON_MINOR, RlmKernel, RlmKernelError, encodeRlmRequest, parseRlmEvent } from "@deepseek-ai/dsh-rlm-kernel";
//#region lib/types/python.js
/**
* Interpreter resolution for the CPython kernel provider. Misconfiguration
* fails at load: a configured interpreter that is not a usable CPython of the
* supported range is an error the operator fixes once, not a per-cell surprise.
*
* @module @deepseek-ai/dsh-rlm-kernel-python/python
*/
/** Probe deadline in milliseconds; a hung interpreter must not block load. */
const PYTHON_PROBE_TIMEOUT_MS = 5e3;
/**
* Parse `platform.python_version()` output.
*
* @param output - the interpreter's printed version string.
* @returns the parsed release triple, or `undefined` when the text is not one.
*/
function parsePythonVersion(output) {
	const { major, minor, micro } = /^(?<major>\d+)\.(?<minor>\d+)\.(?<micro>\d+)$/u.exec(output.trim())?.groups ?? {};
	if (major === void 0 || minor === void 0 || micro === void 0) return void 0;
	return {
		major: Number(major),
		minor: Number(minor),
		micro
	};
}
/**
* Whether one release is inside the range the kernel runtime supports.
*
* @param release - the parsed release triple.
* @returns whether the interpreter is new enough to run the kernel.
*/
function isSupportedPython(release) {
	if (release.major !== RLM_MINIMUM_PYTHON_MAJOR) return release.major > RLM_MINIMUM_PYTHON_MAJOR;
	return release.minor >= RLM_MINIMUM_PYTHON_MINOR;
}
/**
* Resolve the configured interpreter and check it is a supported CPython.
*
* @param configured - an absolute executable path or a bare command resolved through `PATH`.
* @returns the resolved interpreter.
* @throws {RlmKernelError} when the command cannot run or is not a supported CPython.
*/
function resolvePythonInterpreter(configured) {
	let output;
	try {
		output = execFileSync(configured, ["-c", "import platform; print(platform.python_version())"], {
			encoding: "utf8",
			timeout: PYTHON_PROBE_TIMEOUT_MS,
			stdio: [
				"ignore",
				"pipe",
				"ignore"
			]
		});
	} catch (error) {
		throw new RlmKernelError(`rlm-kernel-python: cannot run interpreter "${configured}"`, { cause: error });
	}
	const release = parsePythonVersion(output);
	if (release === void 0) throw new RlmKernelError(`rlm-kernel-python: interpreter "${configured}" did not report a version`);
	if (!isSupportedPython(release)) throw new RlmKernelError(`rlm-kernel-python: interpreter "${configured}" is ${release.major}.${release.minor}, but the kernel needs ${RLM_MINIMUM_PYTHON_MAJOR}.${RLM_MINIMUM_PYTHON_MINOR} or newer`);
	return {
		bin: configured,
		version: output.trim()
	};
}
//#endregion
//#region lib/types/index.js
/**
* Service Provider for the `ctx.rlmKernel` capability seam: one persistent
* CPython subprocess per agent session. The child runs `python -m rlm.repl`
* from the `py/` directory this package ships, so the runtime travels with the
* plugin instead of requiring a pre-installed Python distribution.
*
* Cells execute in one namespace that survives across turns, model code can
* `await` at top level, and an `interrupt` raises `KeyboardInterrupt` inside
* the running cell without killing the interpreter. Model code holds
* shell-equivalent trust: the provider contains runaway work through output
* caps and a shutdown deadline, but the child is not a security boundary.
*
* @module @deepseek-ai/dsh-rlm-kernel-python
*/
/** Default per-channel capture cap in characters. */
const DEFAULT_MAX_OUTPUT_CHARS = 65536;
/** Default ceiling on the startup handshake in milliseconds. */
const DEFAULT_STARTUP_TIMEOUT_MS = 3e4;
/** Default grace period between `shutdown` and SIGKILL in milliseconds. */
const DEFAULT_SHUTDOWN_GRACE_MS = 3e3;
/** Request id of the startup bootstrap cell, reserved so consumer cells keep sequential ids. */
const BOOTSTRAP_REQUEST_ID = "0";
/**
* Bootstrap cell binding the runtime's model-facing conveniences into the
* fresh user namespace. The snapshot and `list_names` filters already skip
* these names, so they never leak into durable state.
*/
const BOOTSTRAP_CODE = [
	"import rlm as _rlm_bootstrap",
	"rlm = _rlm_bootstrap.rlm",
	"bash = _rlm_bootstrap.bash",
	"import rlm.mcp as mcp",
	"del _rlm_bootstrap"
].join("\n");
/** Absolute directory of the `py/` tree this package ships. */
function pythonSourceDir() {
	return fileURLToPath(new URL("../py/", import.meta.url));
}
/** Whether the configuration can start a kernel at all. */
function assertServiceableConfig(config) {
	if (config.pythonBin.get().trim() === "") throw new Error("rlm-kernel-python: pythonBin must not be empty");
	if (config.maxOutputChars.get() <= 0) throw new Error("rlm-kernel-python: maxOutputChars must be positive");
	if (config.startupTimeoutMs.get() <= 0) throw new Error("rlm-kernel-python: startupTimeoutMs must be positive");
	if (config.shutdownGraceMs.get() <= 0) throw new Error("rlm-kernel-python: shutdownGraceMs must be positive");
}
/** Append captured text under a per-channel character cap. */
function appendCapped(current, text, cap) {
	const merged = `${current}${text}`;
	return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}
/** CPython kernel provider registering itself as `ctx.rlmKernel`. */
var PythonRlmKernel = class extends RlmKernel {
	config;
	static Config = z.object({
		pythonBin: z.string().default("python3").volatile(),
		pythonPath: z.array(z.string()).default([]).volatile(),
		maxOutputChars: z.number().default(DEFAULT_MAX_OUTPUT_CHARS).volatile(),
		startupTimeoutMs: z.number().default(DEFAULT_STARTUP_TIMEOUT_MS).volatile(),
		shutdownGraceMs: z.number().default(DEFAULT_SHUTDOWN_GRACE_MS).volatile()
	});
	entries = /* @__PURE__ */ new Map();
	constructor(ctx, config) {
		super(ctx);
		this.config = config;
		assertServiceableConfig(config);
		resolvePythonInterpreter(config.pythonBin.get());
		ctx.on("agent/disposed", ({ agent }) => {
			const entry = this.entries.get(agent.id);
			if (entry === void 0) return;
			this.entries.delete(agent.id);
			this.disposeEntry(entry);
		});
		ctx.effect(() => async () => {
			const entries = [...this.entries.values()];
			this.entries.clear();
			await Promise.all(entries.map((entry) => this.disposeEntry(entry)));
		});
	}
	/**
	* The kernel handle for one session, starting the interpreter on first use.
	*
	* @param agent - the session-backed agent that owns the kernel.
	* @param options - host handlers and module search path applied at creation.
	* @returns the session's live kernel handle.
	*/
	async acquire(agent, options) {
		const existing = this.entries.get(agent.id);
		if (existing !== void 0 && !existing.disposed && existing.dead === void 0) {
			existing.handle ??= this.createHandle(existing);
			return existing.handle;
		}
		const entry = this.createEntry(agent, options?.hostRequests ?? {});
		this.entries.set(agent.id, entry);
		try {
			await this.start(entry, options?.pythonPath ?? []);
			await this.runBootstrap(entry);
		} catch (error) {
			if (this.entries.get(agent.id) === entry) this.entries.delete(agent.id);
			await this.disposeEntry(entry);
			throw error instanceof Error ? error : new RlmKernelError("rlm-kernel-python: startup failed");
		}
		entry.handle ??= this.createHandle(entry);
		return entry.handle;
	}
	/**
	* The handle over one live entry.
	*
	* @param entry - the kernel entry the handle drives.
	* @returns the handle the seam exposes to consumers.
	*/
	createHandle(entry) {
		return {
			sessionId: entry.agent.id,
			execute: (code, options) => this.runCell(entry, code, options),
			interrupt: () => {
				try {
					this.writeRequest(entry, { type: "interrupt" });
				} catch {}
			},
			snapshot: (request) => this.runSnapshot(entry, request),
			restore: (path) => this.runRestore(entry, path),
			listNames: () => this.runListNames(entry),
			dispose: () => this.disposeEntry(entry)
		};
	}
	/**
	* Bind the runtime's conveniences (`rlm`, `bash`, `mcp`) into the fresh
	* namespace, failing startup when the bootstrap cell itself fails.
	*
	* @param entry - the kernel entry that just completed its handshake.
	*/
	async runBootstrap(entry) {
		const settled = this.register(entry, BOOTSTRAP_REQUEST_ID, "execute");
		this.submit(entry, {
			type: "execute",
			id: BOOTSTRAP_REQUEST_ID,
			code: BOOTSTRAP_CODE
		}, BOOTSTRAP_REQUEST_ID);
		const cell = await settled;
		if (cell.status === "ok") return;
		throw new RlmKernelError(`rlm-kernel-python: runtime bootstrap failed: ${[cell.error?.evalue, cell.stderr.trim()].filter((text) => text !== void 0 && text !== "").join("\n")}`);
	}
	/**
	* Stop and forget the kernel a session owns, when it has one.
	*
	* @param sessionId - identity of the session whose kernel is released.
	*/
	async release(sessionId) {
		const entry = this.entries.get(sessionId);
		if (entry === void 0) return;
		this.entries.delete(sessionId);
		await this.disposeEntry(entry);
	}
	createEntry(agent, hostRequests) {
		const handshake = Promise.withResolvers();
		const ready = handshake.promise;
		return {
			agent,
			hostRequests,
			handle: void 0,
			child: void 0,
			stdin: void 0,
			pending: /* @__PURE__ */ new Map(),
			orphanStdout: "",
			orphanStderr: "",
			orphanDisplay: [],
			ready,
			releaseReady: handshake.resolve,
			rejectReady: handshake.reject,
			readySettled: false,
			dead: void 0,
			disposed: false,
			nextId: 1
		};
	}
	async start(entry, extraPath) {
		const interpreter = resolvePythonInterpreter(this.config.pythonBin.get());
		const searchPath = [
			pythonSourceDir(),
			...this.config.pythonPath.get(),
			...extraPath
		].filter((directory) => directory !== "").join(delimiter);
		const child = spawn(interpreter.bin, [
			"-u",
			"-m",
			"rlm.repl"
		], {
			env: {
				...process.env,
				PYTHONPATH: searchPath
			},
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			]
		});
		entry.child = child;
		entry.stdin = child.stdin ?? void 0;
		let stderr = "";
		child.stderr?.on("data", (chunk) => {
			stderr = chunk.toString("utf8").slice(-4096);
		});
		const closed = new Promise((resolveClose) => {
			child.on("close", () => {
				resolveClose();
			});
		});
		child.on("error", (error) => {
			this.failEntry(entry, error);
		});
		this.pump(entry, child, stderr);
		let timer;
		try {
			await Promise.race([
				entry.ready,
				closed.then(() => {
					throw new RlmKernelError(`rlm-kernel-python: interpreter exited before the handshake: ${stderr.trim()}`);
				}),
				new Promise((_resolve, rejectTimeout) => {
					timer = setTimeout(() => {
						rejectTimeout(new RlmKernelError(`rlm-kernel-python: startup handshake timed out after ${String(this.config.startupTimeoutMs.get())}ms`));
					}, this.config.startupTimeoutMs.get());
				})
			]);
		} finally {
			clearTimeout(timer);
		}
	}
	async pump(entry, child, stderr) {
		const stdout = child.stdout;
		if (stdout === null) {
			this.failEntry(entry, new RlmKernelError("rlm-kernel-python: interpreter has no stdout pipe"));
			return;
		}
		const lines = createInterface({ input: stdout });
		try {
			for await (const line of lines) this.route(entry, line);
		} catch {}
		if (!entry.readySettled) {
			entry.readySettled = true;
			entry.rejectReady(new RlmKernelError(`rlm-kernel-python: interpreter exited before the handshake: ${stderr.trim()}`));
		}
		this.failEntry(entry, new RlmKernelError(`rlm-kernel-python: interpreter exited: ${stderr.trim()}`));
	}
	failEntry(entry, error) {
		if (entry.dead !== void 0) return;
		entry.dead = error;
		if (!entry.readySettled) {
			entry.readySettled = true;
			entry.rejectReady(error);
		}
		for (const pending of [...entry.pending.values()]) {
			entry.pending.delete(pending.id);
			pending.fail(error);
		}
	}
	route(entry, line) {
		const event = parseRlmEvent(line);
		if (event === void 0) return;
		if (event.event === "ready") {
			if (!entry.readySettled) {
				entry.readySettled = true;
				entry.releaseReady();
			}
			return;
		}
		if (event.event === "host_request") {
			this.answer(entry, event);
			return;
		}
		if (event.event === "done") {
			this.settle(entry, event);
			return;
		}
		this.collect(entry, event);
	}
	collect(entry, event) {
		const active = this.activeExecute(entry);
		const owner = active !== void 0 && (event.id === active.id || event.id === null) ? active : void 0;
		const cap = this.config.maxOutputChars.get();
		switch (event.event) {
			case "stdout":
			case "stderr":
				if (owner === void 0) {
					if (event.event === "stdout") entry.orphanStdout = appendCapped(entry.orphanStdout, event.text, cap);
					else entry.orphanStderr = appendCapped(entry.orphanStderr, event.text, cap);
					return;
				}
				owner[event.event] = appendCapped(owner[event.event], event.text, cap);
				owner.onEvent?.(event);
				return;
			case "result":
				if (owner === void 0) return;
				owner.representation = event.text;
				owner.onEvent?.(event);
				return;
			case "display":
				if (owner === void 0) entry.orphanDisplay.push(event);
				else {
					owner.display.push(event);
					owner.onEvent?.(event);
				}
				return;
			case "error":
				if (owner === void 0) return;
				owner.error = {
					ename: event.ename,
					evalue: event.evalue,
					traceback: event.traceback
				};
				owner.onEvent?.(event);
		}
	}
	activeExecute(entry) {
		for (const pending of entry.pending.values()) if (pending.kind === "execute") return pending;
	}
	settle(entry, event) {
		const pending = entry.pending.get(event.id);
		if (pending === void 0) return;
		entry.pending.delete(event.id);
		pending.onEvent?.(event);
		if (pending.kind !== "execute") {
			this.settleMaintenance(pending, event);
			return;
		}
		const result = {
			status: event.status,
			stdout: `${entry.orphanStdout}${pending.stdout}`,
			stderr: `${entry.orphanStderr}${pending.stderr}`,
			display: [...entry.orphanDisplay, ...pending.display],
			...pending.representation === void 0 ? {} : { representation: pending.representation },
			...pending.error === void 0 ? {} : { error: pending.error },
			durationMs: Date.now() - pending.startedAt
		};
		entry.orphanStdout = "";
		entry.orphanStderr = "";
		entry.orphanDisplay = [];
		pending.settle(result);
	}
	settleMaintenance(pending, event) {
		if (event.status === "error") {
			pending.fail(new RlmKernelError(`rlm-kernel-python: ${pending.kind} failed: ${event.reason ?? "unknown reason"}`));
			return;
		}
		if (pending.kind === "snapshot") {
			const result = {
				saved: event.saved ?? [],
				skipped: event.skipped ?? [],
				pruned: event.pruned ?? [],
				bytes: event.bytes ?? 0
			};
			pending.settle(result);
			return;
		}
		if (pending.kind === "restore") {
			const result = {
				restored: event.restored ?? [],
				failed: event.failed ?? []
			};
			pending.settle(event.reason === void 0 ? result : {
				...result,
				reason: event.reason
			});
			return;
		}
		pending.settle(event.names ?? []);
	}
	/**
	* Write one request on the child's stdin, retiring its pending entry when the
	* pipe refuses it. A failed write settles the request here so the entry's
	* pending table never keeps a request no `done` event will ever answer.
	*
	* @param entry - the kernel entry the request belongs to.
	* @param request - the request to serialize.
	* @param id - identity of the pending entry the write serves.
	*/
	submit(entry, request, id) {
		try {
			this.writeRequest(entry, request);
		} catch (error) {
			const pending = entry.pending.get(id);
			if (pending === void 0) return;
			entry.pending.delete(id);
			pending.fail(error instanceof Error ? error : new RlmKernelError("rlm-kernel-python: request could not be submitted"));
		}
	}
	writeRequest(entry, request) {
		if (entry.disposed || entry.dead !== void 0) throw new RlmKernelError("rlm-kernel-python: kernel is not running");
		const stdin = entry.stdin;
		if (stdin === void 0 || stdin.writableEnded) throw new RlmKernelError("rlm-kernel-python: kernel has no writable stdin");
		stdin.write(encodeRlmRequest(request));
	}
	async runCell(entry, code, options) {
		this.assertLive(entry);
		const id = String(entry.nextId);
		entry.nextId += 1;
		const settled = this.register(entry, id, "execute", options?.onEvent);
		if (options?.signal?.aborted === true) this.submit(entry, { type: "interrupt" }, id);
		options?.signal?.addEventListener("abort", () => {
			try {
				this.writeRequest(entry, { type: "interrupt" });
			} catch {}
		}, { once: true });
		this.submit(entry, {
			type: "execute",
			id,
			code
		}, id);
		return settled;
	}
	async runSnapshot(entry, request) {
		this.assertLive(entry);
		const id = String(entry.nextId);
		entry.nextId += 1;
		const settled = this.register(entry, id, "snapshot");
		this.submit(entry, {
			type: "snapshot",
			id,
			path: request.path,
			manifest_path: request.manifest_path,
			...request.max_bytes === void 0 ? {} : { max_bytes: request.max_bytes },
			...request.max_variable_bytes === void 0 ? {} : { max_variable_bytes: request.max_variable_bytes },
			...request.prune_oversized === void 0 ? {} : { prune_oversized: request.prune_oversized }
		}, id);
		return settled;
	}
	async runRestore(entry, path) {
		this.assertLive(entry);
		const id = String(entry.nextId);
		entry.nextId += 1;
		const settled = this.register(entry, id, "restore");
		this.submit(entry, {
			type: "restore",
			id,
			path
		}, id);
		return settled;
	}
	async runListNames(entry) {
		this.assertLive(entry);
		const id = String(entry.nextId);
		entry.nextId += 1;
		const settled = this.register(entry, id, "list_names");
		this.submit(entry, {
			type: "list_names",
			id
		}, id);
		return settled;
	}
	assertLive(entry) {
		if (entry.disposed) throw new RlmKernelError("rlm-kernel-python: kernel is disposed");
		if (entry.dead !== void 0) throw entry.dead;
	}
	register(entry, id, kind, onEvent) {
		return new Promise((resolvePromise, rejectPromise) => {
			const pending = {
				id,
				kind,
				startedAt: Date.now(),
				stdout: "",
				stderr: "",
				display: [],
				settle: (value) => {
					resolvePromise(value);
				},
				fail: (error) => {
					rejectPromise(error);
				},
				...onEvent === void 0 ? {} : { onEvent }
			};
			entry.pending.set(id, pending);
		});
	}
	async answer(entry, event) {
		const type = hostRequestType(event);
		const handler = type === void 0 ? void 0 : this.hostRequestHandler(entry.hostRequests, type);
		const controller = new AbortController();
		let data;
		if (handler === void 0) data = {
			status: "error",
			error: `rlm-kernel-python: no host handler for "${type ?? ""}"`
		};
		else try {
			data = await handler(event, {
				agent: entry.agent,
				signal: controller.signal
			});
		} catch (error) {
			data = {
				status: "error",
				error: error instanceof Error ? error.message : String(error)
			};
		}
		this.writeRequest(entry, {
			type: "host_reply",
			id: event.id,
			data
		});
	}
	async disposeEntry(entry) {
		if (entry.disposed) return;
		entry.disposed = true;
		const child = entry.child;
		entry.child = void 0;
		entry.stdin = void 0;
		for (const pending of [...entry.pending.values()]) {
			entry.pending.delete(pending.id);
			pending.fail(new RlmKernelError("rlm-kernel-python: kernel was disposed"));
		}
		if (child === void 0) return;
		const exited = new Promise((resolveExited) => {
			child.on("close", () => {
				resolveExited();
			});
		});
		try {
			child.stdin?.write(encodeRlmRequest({ type: "shutdown" }));
			child.stdin?.end();
		} catch {}
		let timer;
		try {
			await Promise.race([exited, new Promise((resolveKill) => {
				timer = setTimeout(() => {
					child.kill("SIGKILL");
					resolveKill();
				}, this.config.shutdownGraceMs.get());
			})]);
		} finally {
			clearTimeout(timer);
		}
	}
};
/**
* The `type` discriminator a host request carries.
*
* @param event - the host request event as the child sent it.
* @returns the request type, or `undefined` when the payload carries none.
*/
function hostRequestType(event) {
	const type = event.data.type;
	return typeof type === "string" ? type : void 0;
}
//#endregion
export { PythonRlmKernel, PythonRlmKernel as default };
