/**
 * Host bindings for the RLM Python runtime's `mcp.*` host requests. The
 * kernel owns the MCP client itself (`py/rlm/mcp.py`); the host only answers
 * where a server's connection configuration lives (`mcp.config`), refreshes a
 * stored credential the kernel re-reads afterwards (`mcp.refresh`), and, when
 * the composition wires an interactive login, starts one (`mcp.begin_login`).
 *
 * @module @deepseek-ai/dsh-rlm-bindings/mcp
 */
import { readFileSync } from 'node:fs';
import { ok } from "./read.js";
/** Structural guard for one entry of the servers file: a plain object with a known transport. */
function isMcpServerConfig(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    if (!('type' in value))
        return false;
    return value.type === 'http' || value.type === 'stdio';
}
/**
 * Reads the user-declared MCP server map from a JSON file. A missing,
 * unreadable, or structurally invalid file reads as an empty map, so a
 * broken file routes every server to the kernel's own "not declared" error
 * instead of failing the host. Re-read on every call, so editing the file
 * reaches the next kernel connection without a plugin restart.
 *
 * @param path - absolute path of the JSON file holding name → server config.
 * @returns the declared servers, or an empty map when none can be read.
 */
export function readMcpServersFile(path) {
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return {};
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        return {};
    const servers = {};
    for (const [name, value] of Object.entries(parsed)) {
        if (isMcpServerConfig(value))
            servers[name] = value;
    }
    return servers;
}
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