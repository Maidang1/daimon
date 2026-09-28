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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "rlm-bindings";
export declare const inject: string[];
/** Plugin configuration for the RLM host bindings. */
export interface Config {
    /** Registry name of the continuable spawn provider children are created through. */
    providerName?: string;
    /** DSH home directory override; empty resolves through `DSH_HOME` or `~/.dsh`. */
    dshHome?: string;
    /**
     * JSON file declaring the MCP servers the kernel may connect to (name →
     * server config). Empty resolves to `<dshHome>/mcp-servers.json`; a
     * missing or invalid file reads as no declared servers.
     */
    mcpServersFile?: string;
}
/** Validated plugin configuration for the RLM host bindings. */
export declare const Config: z<Config>;
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
export declare function apply(ctx: Context, config?: Config): void;
//# sourceMappingURL=index.d.ts.map