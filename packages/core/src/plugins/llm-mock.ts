/**
 * Offline mock LLM adapter.
 *
 * Demonstrates the full agent loop without any network or API key: on the
 * first turn it asks the `echo` tool to repeat the user's text; on a follow-up
 * turn (when a `tool` result is already present) it produces a final answer.
 * This mirrors DeepSeek Harness' mock-delegating-LLM fixtures used in tests.
 */

import type { Context } from 'cordis'
import type { ChatMessage, ChatResponse, ChatStreamChunk, ModelInfo } from '../types.js'
import { LlmService } from '../services/llm.js'
import { definePlugin } from './util.js'

const ID = 'mock-llm'

export interface MockLlmConfig {
  /** Tool the mock asks for on the first turn. */
  tool?: string
}

class LlmMock extends LlmService {
  private readonly tool: string

  constructor(ctx: Context, config: MockLlmConfig = {}) {
    super(ctx)
    this.tool = config.tool ?? 'echo'
  }

  async chat(messages: ChatMessage[]): Promise<ChatResponse> {
    const hasToolResult = messages.some((m) => m.role === 'tool')
    if (!hasToolResult) {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user')
      const text = typeof lastUser?.content === 'string' ? lastUser.content : ''
      return {
        toolCalls: [
          {
            id: `${ID}-${Date.now()}`,
            name: this.tool,
            arguments: JSON.stringify({ text }),
          },
        ],
      }
    }
    const echoed = messages.find((m) => m.role === 'tool')?.content
    const echoedText = typeof echoed === 'string' ? echoed : JSON.stringify(echoed)
    return {
      content: `Mock LLM received your message and the tool returned: ${echoedText}`,
    }
  }

  async models(): Promise<ModelInfo[]> {
    return [{ id: ID, ownedBy: 'resolve-studio' }]
  }

  /**
   * Simulated streaming: same behaviour as {@link chat}, but the final answer
   * is emitted character-by-character so the web UI's typewriter effect can be
   * exercised offline (no network / API key needed). Also emits a fake
   * `reasoning` block so the thinking UI is visible without a real model.
   */
  async *chatStream(messages: ChatMessage[]): AsyncIterable<ChatStreamChunk> {
    const hasToolResult = messages.some((m) => m.role === 'tool')
    if (!hasToolResult) {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user')
      const text = typeof lastUser?.content === 'string' ? lastUser.content : ''
      yield { reasoning: '思考：用户请求需要调用工具确认，我先调用它再总结。' }
      yield {
        toolCalls: [
          {
            index: 0,
            id: `${ID}-${Date.now()}`,
            name: this.tool,
            arguments: JSON.stringify({ text }),
          },
        ],
      }
      return
    }
    const echoed = messages.find((m) => m.role === 'tool')?.content
    const echoedText = typeof echoed === 'string' ? echoed : JSON.stringify(echoed)
    const answer = `Mock LLM received your message and the tool returned: ${echoedText}`
    yield { reasoning: '思考：工具结果已返回，现在整理成最终回答。' }
    for (const char of answer) {
      yield { content: char }
    }
  }
}

export const llmMock = definePlugin(LlmMock, 'llm-mock', [])
