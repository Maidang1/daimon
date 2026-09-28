/**
 * Host bindings for the RLM Python runtime's `mcp.*` host requests. The
 * kernel owns the MCP client itself (`py/rlm/mcp.py`); the host only answers
 * where a server's connection configuration lives (`mcp.config`), refreshes a
 * stored credential the kernel re-reads afterwards (`mcp.refresh`), and, when
 * the composition wires an interactive login, starts one (`mcp.begin_login`).
 *
 * @module @deepseek-ai/dsh-rlm-bindings/mcp
 */
import { ok } from "./read.js";
/**
 * Read the required `server` member of one `mcp.*` payload.
 *
 * @param data - the `host_request` payload.
 * @param operation - the wire type the error message names.
 * @returns the server name.
 */
function serverField(data, operation) {
    const value = data['server'];
    const server = typeof value === 'string' ? value : '';
    if (server.length === 0)
        throw new Error(`${operation} requires a server`);
    return server;
}
/**
 * Assemble the MCP host handlers the bindings answer.
 *
 * The map holds `mcp.config` and `mcp.refresh` unconditionally;
 * `mcp.begin_login` appears only when the composition wired an interactive
 * login, so the kernel never meets a handler whose only behavior is to throw.
 *
 * @param deps - the composition services captured at load.
 * @returns the handler map to register on `ctx.rlmKernel`.
 */
export function createMcpHostHandlers(deps) {
    const servers = deps.servers ?? (() => undefined);
    const handlers = {
        'mcp.config': (request) => {
            const server = serverField(request.data, 'mcp.config');
            const config = servers()?.[server];
            return Promise.resolve(ok(config === undefined ? {} : { ...config }));
        },
        'mcp.refresh': async (request) => {
            const server = serverField(request.data, 'mcp.refresh');
            const refresh = deps.refreshCredential;
            const key = refresh === undefined ? undefined : await refresh(server);
            if (key !== undefined && key.length > 0)
                return ok({});
            throw new Error(`Could not refresh credentials for ${server}`);
        },
    };
    const beginLogin = deps.beginLogin;
    if (beginLogin !== undefined) {
        handlers['mcp.begin_login'] = async (request) => {
            const server = serverField(request.data, 'mcp.begin_login');
            await beginLogin(server);
            return ok({});
        };
    }
    return handlers;
}
//# sourceMappingURL=mcp.js.map