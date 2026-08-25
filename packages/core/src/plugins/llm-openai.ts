/**
 * OpenAI-compatible LLM adapter.
 *
 * Talks to any OpenAI-compatible `/chat/completions` endpoint (OpenAI, DeepSeek,
 * a local llama.cpp server, ...). Configuration comes from `cordis.yml` config
 * and is overridable by environment variables, mirroring DeepSeek Harness'
 * `llm-deepseek` adapter.
 */

import OpenAI from 'openai'
import type { Context } from 'cordis'
import type {
  ChatMessage,
  ChatOptions,
  ChatResponse,
  ChatStreamChunk,
  ModelInfo,
  ToolSchema,
} from '../types.js'
import { LlmService } from '../services/llm.js'
import { definePlugin } from './util.js'

export interface OpenAiLlmConfig {
  /** API key. Falls back to `OPENAI_API_KEY`. */
  apiKey?: string
  /** Base URL, e.g. `https://api.openai.com/v1`. Falls back to `OPENAI_BASE_URL`. */
  baseURL?: string
  /** Default model id. Falls back to `OPENAI_MODEL` / `deepseek-chat`. */
  model?: string
  temperature?: number
  maxTokens?: number
  /** Extra request timeout in milliseconds. */
  timeout?: number
}

function contentToString(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content
  return content.map((p) => (p.type === 'text' ? p.text : '')).join('')
}

/**
 * Hard cap on a single message sent to the LLM, so one oversized tool result
 * (e.g. a 20k-file directory tree from an external `fs:directory_tree`) can
 * never blow the model's context window and trigger a 400. Tool results are
 * capped tighter than other roles because they are the usual culprits.
 */
const TOOL_MSG_MAX_CHARS = 48 * 1024
const OTHER_MSG_MAX_CHARS = 64 * 1024

function truncateContent(content: string, role: ChatMessage['role']): string {
  const limit = role === 'tool' ? TOOL_MSG_MAX_CHARS : OTHER_MSG_MAX_CHARS
  if (content.length <= limit) return content
  const note =
    role === 'tool'
      ? `\n\n[⚠️ tool result truncated to the first ${limit} of ${content.length} chars — it was too large for the model context. For directory analysis prefer the \`analyze_directory\` tool, which returns a bounded summary.]`
      : `\n\n[message truncated to the first ${limit} of ${content.length} chars to fit the model context]`
  const keep = Math.max(0, limit - note.length)
  return content.slice(0, keep) + note
}

function toOpenAiTools(options?: ChatOptions) {
  if (!options?.tools?.length) return undefined
  return options.tools.map((t: ToolSchema) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  })) as unknown as OpenAI.Chat.Completions.ChatCompletionTool[]
}

/** Map our ChatMessage shape to OpenAI's message params. */
function toOpenAiMessages(messages: ChatMessage[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return messages.map((m) => ({
    role: m.role,
    content: truncateContent(contentToString(m.content), m.role),
    ...(m.role === 'tool' && m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    ...(m.role === 'assistant' && m.name ? { name: m.name } : {}),
  })) as OpenAI.Chat.Completions.ChatCompletionMessageParam[]
}

class LlmOpenAI extends LlmService {
    private readonly client: OpenAI
    /** The model id actually used when the caller does not override it. */
    readonly defaultModel: string
    private readonly temperature: number
    private readonly maxTokens?: number

    constructor(ctx: Context, config: OpenAiLlmConfig = {}) {
      super(ctx)
      this.defaultModel = config.model ?? process.env['OPENAI_MODEL'] ?? 'deepseek-chat'
      this.temperature = config.temperature ?? 0.7
      this.maxTokens = config.maxTokens
      this.client = new OpenAI({
        apiKey: config.apiKey ?? process.env['OPENAI_API_KEY'] ?? 'sk-missing',
        baseURL: config.baseURL ?? process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1',
        timeout: config.timeout ?? 60_000,
      })
      ctx.logger('llm-openai').info('endpoint=%s model=%s', this.client.baseURL, this.defaultModel)
    }

    async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
      const model = options?.model ?? this.defaultModel
      const completion = await this.client.chat.completions.create(
        {
          model,
          temperature: options?.temperature ?? this.temperature,
          max_tokens: options?.maxTokens ?? this.maxTokens,
          messages: toOpenAiMessages(messages),
          tools: toOpenAiTools(options),
          tool_choice:
            options?.toolChoice === undefined
              ? undefined
              : options.toolChoice === 'auto' || options.toolChoice === 'none'
                ? options.toolChoice
                : { type: 'function', function: { name: options.toolChoice.name } },
        },
        { signal: options?.signal },
      )

      const choice = completion.choices[0]
      if (!choice) throw new Error('OpenAI returned no choices')

      const message = choice.message
      const toolCalls = (message.tool_calls ?? [])
        .filter((tc): tc is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall =>
          tc.type === 'function')
        .map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        }))

      const usage = (completion as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage
      const usageSvc = this.ctx.usage
      if (usage && usageSvc) {
        usageSvc.record(model, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0, options?.bus)
      }

      return {
        content: message.content ?? undefined,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        raw: completion,
      }
    }

    async *chatStream(
      messages: ChatMessage[],
      options?: ChatOptions,
    ): AsyncIterable<ChatStreamChunk> {
      const model = options?.model ?? this.defaultModel
      const stream = await this.client.chat.completions.create(
        {
          model,
          temperature: options?.temperature ?? this.temperature,
          max_tokens: options?.maxTokens ?? this.maxTokens,
          messages: toOpenAiMessages(messages),
          tools: toOpenAiTools(options),
          tool_choice:
            options?.toolChoice === undefined
              ? undefined
              : options.toolChoice === 'auto' || options.toolChoice === 'none'
                ? options.toolChoice
                : { type: 'function', function: { name: options.toolChoice.name } },
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: options?.signal },
      )

      let lastUsage: { prompt_tokens?: number; completion_tokens?: number } | undefined
      for await (const chunk of stream) {
        if ((chunk as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage) {
          lastUsage = (chunk as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage
        }
        const delta = chunk.choices[0]?.delta
        if (!delta) continue
        if (delta.content) yield { content: delta.content }
        // DeepSeek-family models stream their thinking via `reasoning_content`
        // (not part of the OpenAI SDK types). Surface it so the UI can show
        // the model's judgement before it acts.
        const reasoning = (delta as unknown as { reasoning_content?: string }).reasoning_content
        if (reasoning) yield { reasoning }
        if (delta.tool_calls?.length) {
          yield {
            toolCalls: delta.tool_calls.map((tc) => ({
              index: tc.index,
              id: tc.id ?? undefined,
              name: tc.function?.name ?? undefined,
              arguments: tc.function?.arguments ?? undefined,
            })),
          }
        }
      }

      const usageSvc = this.ctx.usage
      if (lastUsage && usageSvc) {
        usageSvc.record(model, lastUsage.prompt_tokens ?? 0, lastUsage.completion_tokens ?? 0, options?.bus)
      }
    }

    async models(): Promise<ModelInfo[]> {
      // Prefer the live model catalog from the upstream `/v1/models` endpoint,
      // but many OpenAI-compatible gateways (e.g. some model routers / private
      // endpoints) do not implement `GET /v1/models`. When that call fails we
      // must NOT break the UI — fall back to the model we already know we
      // default to, so the dropdown still pre-selects the right entry.
      try {
        const list = await this.client.models.list()
        const mapped = list.data.map((m) => ({ id: m.id, ownedBy: m.owned_by }))
        if (mapped.length) return mapped
      } catch (err) {
        this.ctx.logger('llm-openai').warn('models.list failed, fallback to default: %s', (err as Error).message)
      }
      return [{ id: this.defaultModel, ownedBy: 'agent-harness' }]
    }
  }

// `usage` is declared in the inject list below, so `this.ctx.usage` resolves
// correctly inside `chat` / `chatStream` (Cordis throws "without inject" if a
// service is accessed without being declared here).
export const llmOpenAi = definePlugin(LlmOpenAI, 'llm-openai', ['usage'])
