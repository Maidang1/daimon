/**
 * Model-facing consumer of the `ctx.rlmKernel` seam: the `python` tool runs one
 * code cell in the session's persistent interpreter.
 *
 * The tool is a leaf over the kernel handle. It contributes the tool schema and
 * the result rendering, enforces the code-length ceiling the operator
 * configured, and forwards the execution's abort signal as a kernel interrupt.
 *
 * @module @deepseek-ai/dsh-tool-python
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "tool-python";
export declare const inject: string[];
/** Model-facing configuration for the `python` tool. */
export interface Config {
    /** Maximum number of characters one call's `code` may carry. */
    maxCodeChars?: number;
}
/** Validated model-facing configuration for the `python` tool. */
export declare const Config: z<Config>;
/**
 * Register the `python` tool over the persistent kernel.
 *
 * A session's kernel starts on the session's first `python` call and survives
 * across turns, so a variable bound by one cell is visible to the next.
 *
 * @param ctx - the Cordis context this plugin registers into.
 * @param config - validated configuration with live budgets.
 */
export declare function apply(ctx: Context, config?: Config): void;
//# sourceMappingURL=index.d.ts.map