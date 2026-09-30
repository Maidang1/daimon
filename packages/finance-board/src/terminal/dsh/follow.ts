/**
 * The chat transcript reducer: wire frames in, `ChatMessage[]` out.
 *
 * This is the highest-risk logic in the terminal — it encodes a pinned
 * protocol whose own docstring warns that bumping dsh requires re-verifying
 * it — and it is pure functions over plain objects with no I/O, which makes
 * it both the most valuable thing here to test and the easiest. All wire
 * parsing lives in `wire.ts`; nothing in this file casts.
 *
 * @module @deepseek-ai/dsh-finance-board/terminal/dsh/follow
 */

import type { ChatMessage } from '../chat/MessageList.js'
import {
  parseCompactStream,
  type ChatEvent,
  type StreamFrame,
} from './wire.js'

/** Streaming bubble state for one in-flight assistant attempt. */
interface LiveAttempt {
  attemptId: string
  /** text-delta fragments keyed by content-block index. */
  blocks: Map<number, string>
}

/** The id the live bubble for an attempt renders under. */
const liveId = (attemptId: string): string => `stream-${attemptId}`

/** Mutable follow state; rebuilt from scratch on every snapshot. */
export class FollowAssembler {
  messages: ChatMessage[] = []
  running = false
  private attempts = new Map<string, LiveAttempt>()

  private push(msg: ChatMessage): void {
    this.messages.push(msg)
  }

  /* ---------- live assistant stream ---------- */

  /** Compact baseline records: per-block accumulated text for an in-flight attempt. */
  applyCompactStream(attemptId: string, stream: unknown): void {
    const attempt = this.attemptFor(attemptId)
    for (const rec of parseCompactStream(stream)) {
      attempt.blocks.set(rec.index, rec.texts.join(''))
    }
    this.syncAttempt(attempt)
  }

  applyStreamFrame(frame: StreamFrame): void {
    switch (frame.type) {
      case 'start':
        this.attempts.set(frame.attemptId, { attemptId: frame.attemptId, blocks: new Map() })
        return
      case 'chunk': {
        const attempt = this.attemptFor(frame.attemptId)
        attempt.blocks.set(frame.index, (attempt.blocks.get(frame.index) ?? '') + frame.text)
        this.syncAttempt(attempt)
        return
      }
      case 'end':
        // The durable assistant/message event supersedes the live bubble.
        this.settle(frame.attemptId)
        return
    }
  }

  /* ---------- durable events ---------- */

  applyEvent(event: ChatEvent): void {
    switch (event.type) {
      case 'turn/start':
        this.running = true
        return

      case 'turn/end':
        this.running = false
        if (event.reason === 'error') {
          this.push({ kind: 'notice', id: `err-${event.seq}`, tone: 'error', text: `出错了：${event.message ?? '未知错误'}` })
        } else if (event.reason === 'aborted') {
          this.push({ kind: 'notice', id: `stop-${event.seq}`, tone: 'info', text: '已停止' })
        }
        return

      case 'user/message':
        this.push({ kind: 'user', id: event.id, text: event.text })
        return

      case 'assistant/message':
        // One teardown path for the live bubble, whichever side notices first.
        this.settle()
        this.push({ kind: 'assistant', id: event.id, text: event.interrupted ? `${event.text}\n\n*（中断）*` : event.text, streaming: false })
        return

      case 'tool/call':
        this.push({ kind: 'tool', id: event.id, name: event.name, argsSummary: event.argsSummary, status: 'running' })
        return

      case 'tool/result': {
        // Keyed off the message list rather than a parallel card map, so the
        // assembler holds one representation of the transcript and updates
        // replace objects instead of mutating them in place.
        const at = this.messages.findIndex(m => m.id === event.id)
        if (at < 0) return
        const card = this.messages[at]
        if (card.kind !== 'tool') return
        this.messages[at] = { ...card, output: event.output, status: event.isError ? 'error' : 'done' }
        return
      }

      case 'unhandled':
        return
    }
  }

  /* ---------- internals ---------- */

  /**
   * Drop live bubbles. The durable `assistant/message` event supersedes the
   * live bubble, so exactly one settled bubble survives per attempt; pass an
   * `attemptId` to settle only that attempt's.
   */
  private settle(attemptId?: string): void {
    if (attemptId !== undefined) this.attempts.delete(attemptId)
    this.messages = this.messages.filter(msg => {
      if (msg.kind !== 'assistant' || !msg.streaming) return true
      return attemptId === undefined ? false : msg.id !== liveId(attemptId)
    })
  }

  private attemptFor(attemptId: string): LiveAttempt {
    let attempt = this.attempts.get(attemptId)
    if (!attempt) {
      attempt = { attemptId, blocks: new Map() }
      this.attempts.set(attemptId, attempt)
    }
    return attempt
  }

  /** Materialise the live bubble for one attempt from its block map. */
  private syncAttempt(attempt: LiveAttempt): void {
    const id = liveId(attempt.attemptId)
    const text = [...attempt.blocks.keys()].sort((a, b) => a - b).map(k => attempt.blocks.get(k) ?? '').join('')
    const at = this.messages.findIndex(m => m.id === id)
    if (at >= 0) {
      const prev = this.messages[at]
      if (prev.kind === 'assistant') this.messages[at] = { ...prev, text, streaming: true }
    } else {
      this.push({ kind: 'assistant', id, text, streaming: true })
    }
  }
}
