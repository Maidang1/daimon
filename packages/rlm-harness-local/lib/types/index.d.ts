/**
 * Service Provider for the `ctx.rlmHarness` capability seam: JSON-file harness
 * state under the DSH home. The machine-wide store lives at
 * `<dshHome>/rlm/harness/harness_state.json`; each session's local store lives
 * at `<dshHome>/rlm/harness/sessions/<sessionId>/harness_state.json`, the same
 * local/global split the reference host keeps between its session artifact
 * directory and its agent directory. Every write re-reads the file under a
 * cross-process writer lock and commits it atomically, so a session and its
 * host tools can refine the same store without losing each other's edits.
 *
 * @module @deepseek-ai/dsh-rlm-harness-local
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { HarnessRefiner } from '@deepseek-ai/dsh-rlm-harness';
import type { HarnessEntry, HarnessEntryInput, HarnessKind, HarnessRefinementProposal, HarnessScopeRef, HarnessState, RefinementEvent } from '@deepseek-ai/dsh-rlm-harness';
export { globalHarnessStatePath, HARNESS_STATE_DIR_MODE, HARNESS_STATE_DIR_NAME, HARNESS_STATE_FILE_MODE, HARNESS_STATE_FILE_NAME, HARNESS_STATE_SCHEMA, harnessStatePath, harnessStoreScope, loadHarnessState, localHarnessStatePath, parseHarnessState, RLM_DIR_NAME, saveHarnessState, serializeHarnessState, } from './store.ts';
/** Plugin configuration for the Local harness refiner. */
export interface Config {
    /** DSH home directory override; empty resolves through `DSH_HOME` or `~/.dsh`. */
    dshHome?: string;
}
/**
 * JSON-file provider registering itself as `ctx.rlmHarness`.
 *
 * The provider is stateless between calls: every method re-reads the
 * addressed store from disk, and every mutation serializes its
 * read-modify-write through the store file's writer lock, so writes another
 * process committed since this service started are never clobbered and the
 * seam's "state as of the call" contract holds across processes.
 */
export declare class LocalHarnessRefiner extends HarnessRefiner {
    readonly config: Config;
    /** Validated plugin configuration; the home is changeable from `cordis.yml`. */
    static Config: z<Schemastery.ObjectS<NoInfer<{
        dshHome: z<string, string, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        dshHome: z<string, string, "defined">;
    }>>, "plain">;
    /** Resolved DSH home the stores live under. */
    private readonly home;
    constructor(ctx: Context, config: Config);
    /** The caller's clock reading for one write. */
    private now;
    /**
     * Run one read-modify-write against a store under its writer lock.
     *
     * @param scope - the scope the mutation addresses.
     * @param operation - the mutation, returning the next state and the call's result.
     * @returns the operation's result once the next state is committed.
     */
    private mutate;
    read(scope?: HarnessScopeRef): Promise<HarnessState>;
    refine(proposal: HarnessRefinementProposal, scope?: HarnessScopeRef): Promise<RefinementEvent>;
    rollback(eventId: string, scope?: HarnessScopeRef): Promise<number>;
    writeEntry(input: HarnessEntryInput, scope?: HarnessScopeRef): Promise<HarnessEntry>;
    list(kind?: HarnessKind, scope?: HarnessScopeRef): Promise<readonly HarnessEntry[]>;
}
export default LocalHarnessRefiner;
//# sourceMappingURL=index.d.ts.map