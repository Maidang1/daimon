/**
 * Interpreter resolution for the CPython kernel provider. Misconfiguration
 * fails at load: a configured interpreter that is not a usable CPython of the
 * supported range is an error the operator fixes once, not a per-cell surprise.
 *
 * @module @deepseek-ai/dsh-rlm-kernel-python/python
 */
/** Probe deadline in milliseconds; a hung interpreter must not block load. */
export declare const PYTHON_PROBE_TIMEOUT_MS = 5000;
/** One release triple reported by an interpreter. */
export interface PythonRelease {
    readonly major: number;
    readonly minor: number;
    readonly micro: string;
}
/** One resolved interpreter. */
export interface PythonInterpreter {
    /** The command the child is spawned with, exactly as configured. */
    readonly bin: string;
    /** The interpreter's own version string, as reported by `platform.python_version()`. */
    readonly version: string;
}
/**
 * Parse `platform.python_version()` output.
 *
 * @param output - the interpreter's printed version string.
 * @returns the parsed release triple, or `undefined` when the text is not one.
 */
export declare function parsePythonVersion(output: string): PythonRelease | undefined;
/**
 * Whether one release is inside the range the kernel runtime supports.
 *
 * @param release - the parsed release triple.
 * @returns whether the interpreter is new enough to run the kernel.
 */
export declare function isSupportedPython(release: PythonRelease): boolean;
/**
 * Resolve the configured interpreter and check it is a supported CPython.
 *
 * @param configured - an absolute executable path or a bare command resolved through `PATH`.
 * @returns the resolved interpreter.
 * @throws {RlmKernelError} when the command cannot run or is not a supported CPython.
 */
export declare function resolvePythonInterpreter(configured: string): PythonInterpreter;
//# sourceMappingURL=python.d.ts.map