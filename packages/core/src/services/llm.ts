/**
 * LLM service — the chat-completion contract for the harness.
 *
 * `LlmService` is an abstract Cordis service registered under `ctx.llm`. The
 * concrete backend is supplied by an *adapter plugin* (`llm-mock` for offline
 * demos, `llm-openai` for an OpenAI-compatible endpoint). Only one adapter is
 * loaded per composition, which is exactly how DeepSeek Harness swaps its
 * `llm-deepseek` / `llm-pi-ai` backends.
 */

import { Context, Service } from 'cordis'
import type {
  ChatMessage,
  ChatOptions,
  ChatResponse,
  ChatStreamChunk,
  ModelInfo,
} from '../types.js'

/** The chat-completion contract every LLM adapter implements. */
export interface Llm {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse>
  models(): Promise<ModelInfo[]>
  /**
   * Optional streaming variant. If not implemented, the agent falls back to
   * {@link chat} and yields the whole response as a single chunk.
   */
  chatStream?(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<ChatStreamChunk>
}

declare module 'cordis' {
  interface Context {
    llm: LlmService
  }
}

export abstract class LlmService extends Service implements Llm {
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }

  abstract chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse>
  abstract models(): Promise<ModelInfo[]>

  /** Default streaming adapter: delegate to {@link chat} and yield once. */
  async *chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<ChatStreamChunk> {
    const response = await this.chat(messages, options)
    if (response.content) yield { content: response.content }
    if (response.toolCalls?.length) {
      yield {
        toolCalls: response.toolCalls.map((call, index) => ({
          index,
          id: call.id,
          name: call.name,
          arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments),
        })),
      }
    }
  }
}
