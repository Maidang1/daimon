/**
 * `rlm.find_models`: search the composition's advertised model catalog without
 * adding it to the system prompt. Scoring mirrors the reference host: exact
 * matches beat prefix matches beat substring matches, ties break by selector.
 *
 * @module @deepseek-ai/dsh-rlm-bindings/models
 */
import type { LlmModelInfo, LlmProviderInfo } from '@deepseek-ai/dsh-llm';
/** The slice of `ctx.llm` model discovery needs. */
export interface ModelCatalog {
    /** Every registered provider route. */
    listProviders(): LlmProviderInfo[];
    /** The advertised models of one provider route. */
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
}
/** One model match carried back to the runtime. */
export type RlmModelMatch = {
    /** Provider route that owns the model. */
    readonly provider: string;
    /** Provider-owned model id. */
    readonly id: string;
    /** Human-readable model name. */
    readonly name: string;
    /** The `provider/model` selector a spawn request quotes. */
    readonly selector: string;
};
/**
 * Score and rank the catalog matches of one query.
 *
 * @param query - the raw search text; an empty query ranks everything equally.
 * @param models - the catalog entries under test.
 * @param limit - the maximum number of matches returned.
 * @returns the best `limit` matches, best first.
 */
export declare function scoreRlmModelMatches(query: string, models: readonly LlmModelInfo[], limit: number): RlmModelMatch[];
/**
 * Search every registered provider's advertised models for one query.
 *
 * @param catalog - the model catalog to search.
 * @param query - the raw search text.
 * @param limit - the maximum number of matches returned.
 * @returns the best `limit` matches, best first.
 */
export declare function findRlmModels(catalog: ModelCatalog, query: string, limit: number): Promise<RlmModelMatch[]>;
//# sourceMappingURL=models.d.ts.map