/**
 * Shared types for the agent harness.
 *
 * The harness follows DeepSeek Harness' "everything is a plugin" shape: an
 * {@link LlmService} provides chat completions, a {@link ToolRegistry} holds
 * callable tools, and an {@link AgentService} drives the agent loop that wires
 * the two together. All three are Cordis services registered on `ctx`.
 */

/** A chat participant role, extended with `tool` for tool results. */
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

/** A single multi-part content block (text only in this scaffold). */
export interface ContentPart {
  type: 'text'
  text: string
}

/** A chat message in the OpenAI-compatible shape. */
export interface ChatMessage {
  role: ChatRole
  /** Text, or a list of content parts. */
  content: string | ContentPart[]
  /** Tool name, for `tool` role messages. */
  name?: string
  /** Links a `tool` role message back to its `tool_calls` id. */
  tool_call_id?: string
}

/** JSON-Schema-ish parameter description for a tool. */
export interface ToolParameter {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array'
  description?: string
  properties?: Record<string, ToolParameter>
  items?: ToolParameter
  required?: string[]
}

/** A tool the agent can call. Mirrors an OpenAI function tool. */
export interface Tool {
  name: string
  description: string
  parameters: ToolParameter
  /** If true, the tool requires human approval before execution. Reserved for
   *  a future human-in-the-loop flow; the scaffold flags it in the UI today. */
  needsApproval?: boolean
  /** Execute the tool. May return a string or structured JSON. */
  execute(args: Record<string, unknown>): Promise<string | object>
}

/** Normalized tool definition passed to the LLM. */
export interface ToolSchema {
  name: string
  description: string
  parameters: ToolParameter
  /** Mirrors {@link Tool.needsApproval} for UI/transport. */
  needsApproval?: boolean
}

/** A tool invocation requested by the model. */
export interface ToolCall {
  id: string
  name: string
  /** Raw JSON string or already-parsed object. */
  arguments: string | Record<string, unknown>
}

/**
 * A minimal event sink the agent loop streams progress on.
 *
 * The web bridge passes a *per-request* bus so two concurrent chats don't
 * cross-talk on the global `ctx.events` bus; the CLI and tests omit it and
 * fall back to the global bus (which keeps their `ctx.events.on(...)` observers
 * working unchanged).
 */
export interface RunEventBus {
  emit(event: string, payload?: unknown): void
}

/** Options for a single chat completion. */
export interface ChatOptions {
  model?: string
  temperature?: number
  maxTokens?: number
  /** Tool schemas the model may call. */
  tools?: ToolSchema[]
  /** Force a specific tool, or `auto`/`none`. */
  toolChoice?: 'auto' | 'none' | { name: string }
  /** Abort signal forwarded to the provider to cancel an in-flight request. */
  signal?: AbortSignal
  /** Per-run event sink; when set, `llm/usage` is emitted here instead of the
   *  global bus so concurrent runs stay isolated. */
  bus?: RunEventBus
}

/** A normalized chat completion response. */
export interface ChatResponse {
  /** Assistant text when the model is not calling a tool. */
  content?: string
  /** Tool invocations requested by the model. */
  toolCalls?: ToolCall[]
  /** The underlying provider response, for debugging. */
  raw?: unknown
}

/** A streaming delta produced by {@link Llm.chatStream}. */
export interface ChatStreamChunk {
  /** A text delta to append to the running assistant content. */
  content?: string
  /**
   * A reasoning/thinking delta (e.g. DeepSeek's `reasoning_content`). Model
   * judgement before a tool call or answer — surfaced to the UI as a
   * collapsible "thinking" block.
   */
  reasoning?: string
  /**
   * Tool-call deltas (OpenAI streaming shape: partial id/name/arguments per
   * `index`). The consumer merges fragments by index to reconstruct calls.
   */
  toolCalls?: { index: number; id?: string; name?: string; arguments?: string }[]
}

/** Model metadata returned by an LLM backend. */
export interface ModelInfo {
  id: string
  ownedBy?: string
}

/** The result of running one step of the agent loop. */
export interface AgentStep {
  /** The assistant message produced this step. */
  message: ChatMessage
  /** Tool calls issued (empty when the agent answered). */
  toolCalls: ToolCall[]
  /** Tool results produced this step, aligned with `toolCalls`. */
  toolResults: { call: ToolCall; result: string; ok: boolean }[]
}

/** Options controlling an agent run. */
export interface AgentRunOptions {
  messages: ChatMessage[]
  /** Override the tools used for this run. */
  tools?: ToolSchema[]
  /** Max loop iterations before giving up (default 8). */
  maxIterations?: number
  model?: string
  /** Abort signal to cancel an in-flight model call. */
  signal?: AbortSignal
  /** Opaque id isolating this run (used to namespace approval call ids so
   *  concurrent runs don't collide). */
  runId?: string
  /** Context-window budget in chars before old messages are trimmed. */
  contextBudgetChars?: number
  /** Per-run event sink. When provided, every `agent/*` and `llm/*` progress
   *  event is emitted here (not the global `ctx.events` bus) so concurrent
   *  runs in the web bridge don't cross-talk. Omit for the CLI / tests. */
  bus?: RunEventBus
}
