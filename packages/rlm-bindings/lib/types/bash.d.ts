/**
 * Background-command completion notices. A detached `bash()` job in the
 * runtime ends out of band, so the bindings steer a one-line notice into the
 * owning session — an idle driver starts a turn, a running one reads it at
 * the next step boundary. When the kernel reads the result first, the notice
 * is stale and is withdrawn from the inbox while it is still pending.
 *
 * @module @deepseek-ai/dsh-rlm-bindings/bash
 */
import type { ContextFormed, MessageId, UserMessage } from '@deepseek-ai/dsh-llm';
import type { BashCompletion } from './read.ts';
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        /** Background-command completion notices steered into the owning session. */
        'rlm-bindings': {
            kind: 'rlm-bindings';
        } & ContextFormed;
    }
}
/**
 * Format the model-facing text of one completion notice.
 *
 * @param details - the validated completion.
 * @returns the one-line header plus the quoted command.
 */
export declare function formatBashCompletionNotice(details: BashCompletion): string;
/**
 * Build the steered user message announcing one completion.
 *
 * @param details - the validated completion.
 * @returns the identified message to steer into the owning session.
 */
export declare function createBashCompletionMessage(details: BashCompletion): UserMessage;
/**
 * Pending completion notices per session, oldest first. One `bash.consumed`
 * withdraws one notice: pids are reused across handles, and the read belongs
 * to the older handle, which is the earlier notice.
 */
export declare class BashNoticeBoard {
    private readonly pending;
    /**
     * Record a steered notice so a later `bash.consumed` can withdraw it.
     *
     * @param agentId - the session the notice was steered into.
     * @param pid - process id of the finished command.
     * @param command - the command line that finished.
     * @param messageId - identity of the steered message.
     */
    record(agentId: string, pid: number, command: string, messageId: MessageId): void;
    /**
     * Withdraw the earliest notice matching one consumed result.
     *
     * @param agentId - the session the notice was steered into.
     * @param pid - process id of the consumed command.
     * @param command - the command line that was read.
     * @returns the steered message's identity, or `undefined` when nothing pending matches.
     */
    takeEarliest(agentId: string, pid: number, command: string): MessageId | undefined;
}
//# sourceMappingURL=bash.d.ts.map