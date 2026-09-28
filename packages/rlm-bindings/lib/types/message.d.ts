/**
 * Session-to-session messaging behind the agent-message skill. Routing is
 * nuclear-family only: the sender resolves its parent, siblings, or direct
 * children from the subagent catalogs, and the message is steered into the
 * resolved live session as a user message stamped with the bindings source.
 * A running target admits the steering at its nearest step boundary, which
 * the receipt reports as queued; an idle target starts a turn, reported as
 * delivered.
 *
 * @module @deepseek-ai/dsh-rlm-bindings/message
 */
import type { ContextFormed } from '@deepseek-ai/dsh-llm';
import type { RlmHostRequestHandlers } from '@deepseek-ai/dsh-rlm-kernel';
import type { AgentFamilyRelationship, FamilySource } from './observe.ts';
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        /** Agent-to-agent messages steered into the receiving session. */
        'rlm-bindings': {
            kind: 'rlm-bindings';
        } & ContextFormed;
    }
}
/** Durable source name carried by every agent-message receipt. */
export declare const AGENT_MESSAGE_SOURCE = "agent_message";
/** Identity prefix distinguishing agent-to-agent messages. */
export declare const AGENT_MESSAGE_ID_PREFIX = "agentmsg_";
/** Hard cap for one agent message, in UTF-16 code units. */
export declare const DEFAULT_AGENT_MESSAGE_MAX_CHARS = 16384;
/** Burst capacity of the per sender-target rate limiter. */
export declare const DEFAULT_AGENT_MESSAGE_RATE_LIMIT_CAPACITY = 3;
/** Refill interval of the per sender-target rate limiter, in milliseconds. */
export declare const DEFAULT_AGENT_MESSAGE_RATE_LIMIT_REFILL_MS = 1000;
/** One endpoint of a delivered agent message, as carried by the receipt. */
export type AgentMessageEndpoint = {
    /** Live session id; dsh keeps one durable id per session, repeated here. */
    readonly activeSessionId: string;
    /** The durable session id. */
    readonly sessionId: string;
    /** Roster name or catalog label, when the endpoint has one. */
    readonly sessionName?: string;
    /** Coarse runtime classification, derived from the durable header. */
    readonly runtimeKind?: 'top-level' | 'subagent';
};
/** The receipt of one accepted agent message. */
export type AgentMessageReceipt = {
    /** Identity of the accepted message. */
    readonly id: string;
    /** Durable source name, always {@link AGENT_MESSAGE_SOURCE}. */
    readonly source: typeof AGENT_MESSAGE_SOURCE;
    /** The receiving endpoint. */
    readonly target: AgentMessageEndpoint;
    /** The sending endpoint. */
    readonly from: AgentMessageEndpoint;
    /** The normalized message text. */
    readonly message: string;
    /** Whether the message started a turn or queued behind running work. */
    readonly deliveryStatus: 'delivered' | 'queued';
    /** When an idle target received the message. */
    readonly deliveredAt?: string;
    /** When a running target parked the message for its next step boundary. */
    readonly queuedAt?: string;
    /** Delivery mechanism, always steering. */
    readonly deliveryMode: 'steer';
};
/** Tuning knobs of the agent-message rate limiter. */
export interface AgentMessageRateLimitOptions {
    /** Burst capacity per sender-target pair. */
    readonly capacity?: number;
    /** Milliseconds between token refills. */
    readonly refillMs?: number;
    /** Clock override, for tests. */
    readonly now?: () => number;
}
/**
 * Token-bucket limiter over sender-target pairs, ported from the reference
 * host: one token per send, refilled one per interval up to the capacity,
 * with a refund when the delivery itself fails.
 */
export declare class AgentMessageRateLimiter {
    private readonly capacity;
    private readonly refillMs;
    private readonly now;
    private readonly buckets;
    /**
     * @param options - tuning knobs; defaults match the reference host.
     */
    constructor(options?: AgentMessageRateLimitOptions);
    /**
     * Take one token for a sender-target pair.
     *
     * @param key - the sender-target pair key.
     * @returns success, or the wait until the next token.
     */
    tryConsume(key: string): {
        ok: true;
    } | {
        ok: false;
        retryAfterMs: number;
    };
    /**
     * Return one token after a failed delivery, so a send that never happened
     * does not spend the pair's budget.
     *
     * @param key - the sender-target pair key.
     */
    refund(key: string): void;
}
/**
 * Normalize one outbound agent message: trimmed, non-empty, and within the
 * size cap. The error texts are model-facing and match the reference host.
 *
 * @param message - the raw message text.
 * @param maxChars - the size cap.
 * @returns the normalized message.
 */
export declare function normalizeAgentSessionMessage(message: string, maxChars?: number): string;
/**
 * Mint the identity of one outbound agent message.
 *
 * @returns a fresh `agentmsg_`-prefixed id.
 */
export declare function createAgentMessageId(): string;
/**
 * The sender's relationship from the receiver's point of view: the inverse
 * of the receiver role the send was addressed with.
 *
 * @param receiverRole - the role the receiver was addressed with.
 * @returns the sender's relationship to the receiver.
 */
export declare function inverseRelationship(receiverRole: AgentFamilyRelationship): AgentFamilyRelationship;
/**
 * Strip the characters that would break the bracket header line of a steered
 * agent message: brackets, newlines, commas, and the relationship separator.
 *
 * @param value - a display name interpolated into the header.
 * @returns the safe header value, or `unknown` when nothing survives.
 */
export declare function sanitizeMessageHeaderValue(value: string): string;
/**
 * Format the model-facing text of one steered agent message, matching the
 * reference host's bracket grammar.
 *
 * @param fromRelationship - the sender's relationship from the receiver's point of view.
 * @param senderName - the sender's display name, sanitized for the header.
 * @param message - the normalized message text.
 * @returns the text the receiving session reads.
 */
export declare function formatAgentMessagePrompt(fromRelationship: AgentFamilyRelationship, senderName: string, message: string): string;
/** Everything the messaging handlers need from the composition. */
export interface AgentMessageDeps extends FamilySource {
    /** Rate limiter tuning; defaults match the reference host. */
    readonly rateLimit?: AgentMessageRateLimitOptions;
}
/**
 * Assemble the messaging handlers the agent-message skill calls.
 *
 * @param deps - the composition services captured at load.
 * @returns the handler map to register on `ctx.rlmKernel`.
 */
export declare function createAgentMessageHostHandlers(deps: AgentMessageDeps): RlmHostRequestHandlers;
//# sourceMappingURL=message.d.ts.map