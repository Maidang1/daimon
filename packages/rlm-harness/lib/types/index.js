/**
 * Service Definition for the `ctx.rlmHarness` capability seam: the durable
 * instructions an agent refines while it works. A consumer reads the current
 * state, submits a refinement proposal, and rolls a proposal back; the provider
 * owns where the state lives and how a session replays it.
 *
 * @module @deepseek-ai/dsh-rlm-harness
 */
import { Service } from '@deepseek-ai/cordis';
export { applyRefinement, DEFAULT_HARNESS_PATH, DEFAULT_HARNESS_SOURCE, emptyHarnessState, entryJson, HARNESS_KINDS, HarnessStateError, normalizeEntry, rollbackToEvent, withEntry, } from "./state.js";
/**
 * Readable, refinable harness state.
 *
 * One provider registers per context; loading a second throws, which is
 * Cordis' standard duplicate-service behavior.
 *
 * Implementations must honor these semantics:
 * - {@link read} returns the state as of the call, including writes another
 *   process made since this service started.
 * - {@link refine} applies the whole proposal or none of it, and records one
 *   {@link RefinementEvent} per accepted proposal.
 * - {@link rollback} removes every refinement after the named one; the entries
 *   those refinements wrote stay, because a rollback is a history operation.
 */
export class HarnessRefiner extends Service {
    constructor(ctx) {
        super(ctx, 'rlmHarness');
    }
}
/**
 * The scopes a harness state can live in.
 *
 * @returns the scope names, session-local first.
 */
export function harnessScopes() {
    return ['local', 'global'];
}
export default HarnessRefiner;
//# sourceMappingURL=index.js.map