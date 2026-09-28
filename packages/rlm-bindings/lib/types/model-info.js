/**
 * Host handler for the `model.info` request: the calling agent's own route
 * and its accepted input modalities. The reference host reads these off the
 * live model object; here the route comes from the agent's options and the
 * modalities from `ctx.llm`'s adapter-resolved metadata, degrading to an
 * empty list when the route cannot be resolved.
 *
 * @module @deepseek-ai/dsh-rlm-bindings/model-info
 */
import { ok } from "./read.js";
/** Read the calling agent's route, resolving modalities best-effort. */
async function modelInfo(deps, context) {
    const provider = context.agent.options.provider;
    const model = context.agent.options.model;
    if (provider === undefined || model === undefined) {
        return { id: model ?? null, provider: provider ?? null, input: [] };
    }
    let input = [];
    try {
        input = (await deps.models.resolveModelInfo(provider, model, context.signal)).inputModalities ?? [];
    }
    catch {
        // The reference host reads modalities off the live model, which never
        // fails; an unresolvable route degrades to the same empty list it would
        // report for a model without declared modalities.
        input = [];
    }
    return { id: model, provider, input: [...input] };
}
/**
 * Assemble the host handler answering `model.info`.
 *
 * @param deps - the composition services captured at load.
 * @returns the handler map to register on `ctx.rlmKernel`.
 */
export function createModelInfoHostHandlers(deps) {
    return {
        'model.info': async (_request, context) => ok(await modelInfo(deps, context)),
    };
}
//# sourceMappingURL=model-info.js.map