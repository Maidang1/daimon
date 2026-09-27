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
import { Context } from '@deepseek-ai/cordis';
import type { Volatile } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import { RlmKernel } from '@deepseek-ai/dsh-rlm-kernel';
import type { RlmKernelAcquireOptions, RlmKernelHandle } from '@deepseek-ai/dsh-rlm-kernel';
/** Validated plugin configuration; every cap is changeable from `cordis.yml`. */
export interface Config {
    /** CPython command: an absolute path or a bare name resolved through `PATH`. */
    pythonBin: Volatile<string>;
    /** Extra directories on the child interpreter's module search path. */
    pythonPath: Volatile<readonly string[]>;
    /** Per-channel capture cap in characters. */
    maxOutputChars: Volatile<number>;
    /** Ceiling on the startup handshake in milliseconds. */
    startupTimeoutMs: Volatile<number>;
    /** Grace period between `shutdown` and SIGKILL in milliseconds. */
    shutdownGraceMs: Volatile<number>;
}
/** CPython kernel provider registering itself as `ctx.rlmKernel`. */
export declare class PythonRlmKernel extends RlmKernel {
    readonly config: Config;
    static Config: z<Schemastery.ObjectS<NoInfer<{
        pythonBin: z<string, string, "volatile-defined">;
        pythonPath: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
        maxOutputChars: z<number, number, "volatile-defined">;
        startupTimeoutMs: z<number, number, "volatile-defined">;
        shutdownGraceMs: z<number, number, "volatile-defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        pythonBin: z<string, string, "volatile-defined">;
        pythonPath: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
        maxOutputChars: z<number, number, "volatile-defined">;
        startupTimeoutMs: z<number, number, "volatile-defined">;
        shutdownGraceMs: z<number, number, "volatile-defined">;
    }>>, "plain">;
    private readonly entries;
    constructor(ctx: Context, config: Config);
    /**
     * The kernel handle for one session, starting the interpreter on first use.
     *
     * @param agent - the session-backed agent that owns the kernel.
     * @param options - host handlers and module search path applied at creation.
     * @returns the session's live kernel handle.
     */
    acquire(agent: Agent, options?: RlmKernelAcquireOptions): Promise<RlmKernelHandle>;
    /**
     * The handle over one live entry.
     *
     * @param entry - the kernel entry the handle drives.
     * @returns the handle the seam exposes to consumers.
     */
    private createHandle;
    /**
     * Bind the runtime's conveniences (`rlm`, `bash`, `mcp`) into the fresh
     * namespace, failing startup when the bootstrap cell itself fails.
     *
     * @param entry - the kernel entry that just completed its handshake.
     */
    private runBootstrap;
    /**
     * Stop and forget the kernel a session owns, when it has one.
     *
     * @param sessionId - identity of the session whose kernel is released.
     */
    release(sessionId: SessionId): Promise<void>;
    private createEntry;
    private start;
    private pump;
    private failEntry;
    private route;
    private collect;
    private activeExecute;
    private settle;
    private settleMaintenance;
    /**
     * Write one request on the child's stdin, retiring its pending entry when the
     * pipe refuses it. A failed write settles the request here so the entry's
     * pending table never keeps a request no `done` event will ever answer.
     *
     * @param entry - the kernel entry the request belongs to.
     * @param request - the request to serialize.
     * @param id - identity of the pending entry the write serves.
     */
    private submit;
    private writeRequest;
    private runCell;
    private runSnapshot;
    private runRestore;
    private runListNames;
    private assertLive;
    private register;
    private answer;
    private disposeEntry;
}
export default PythonRlmKernel;
//# sourceMappingURL=index.d.ts.map