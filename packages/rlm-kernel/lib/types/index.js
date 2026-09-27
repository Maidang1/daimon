/**
 * Service Definition for the `ctx.rlmKernel` capability seam: one persistent
 * Python REPL per agent session. A consumer asks for the kernel of a session
 * and receives a handle that runs code cells, interrupts them, and snapshots
 * the namespace; the provider owns the process, the wire protocol, and the
 * interpreter.
 *
 * @module @deepseek-ai/dsh-rlm-kernel
 */
import { Service } from '@deepseek-ai/cordis';
export { RlmKernelError } from "./error.js";
export { encodeRlmRequest, parseRlmEvent, rebuildEvent, RLM_FRAME_SEPARATOR, RLM_MINIMUM_PYTHON_MAJOR, RLM_MINIMUM_PYTHON_MINOR, RLM_PROTOCOL_VERSION, } from "./protocol.js";
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
export class RlmKernel extends Service {
    /** Handler maps mounted by other plugins, oldest first. */
    hostRequestRegistrations = [];
    constructor(ctx) {
        super(ctx, 'rlmKernel');
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
            if (withdrawn)
                return;
            withdrawn = true;
            const index = this.hostRequestRegistrations.indexOf(handlers);
            if (index !== -1)
                this.hostRequestRegistrations.splice(index, 1);
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
        if (ownHandler !== undefined)
            return ownHandler;
        for (const handlers of this.hostRequestRegistrations) {
            const handler = handlers[type];
            if (handler !== undefined)
                return handler;
        }
        return undefined;
    }
}
export default RlmKernel;
//# sourceMappingURL=index.js.map