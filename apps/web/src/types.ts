// Shared protocol between the web-server plugin (Node) and the React UI.
// These mirror the agent-harness `src/types.ts` shapes that matter to the UI.

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCall {
  id: string
  name: string
  arguments: string | Record<string, unknown>
}

export interface ToolResult {
  call: ToolCall
  result: string
  ok: boolean
}

export interface AgentStep {
  message: {
    role: ChatRole
    content: string
    toolCalls?: ToolCall[]
  }
  toolCalls: ToolCall[]
  toolResults: ToolResult[]
}

// ---- SSE event payloads (event: <type>\ndata: <json>\n\n) ----

export interface UsageRecord {
  model: string
  promptTokens: number
  completionTokens: number
  cost: number
}

export type ChatEvent =
  | { type: 'step'; step: AgentStep }
  | { type: 'tool-call'; call: ToolCall }
  | { type: 'tool-result'; payload: ToolResult }
  | { type: 'approval-request'; call: ToolCall }
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'usage'; record: UsageRecord }
  | { type: 'done'; answer: string }
  | { type: 'error'; message: string }

/** A persisted conversation (web UI history). */
export interface SessionMeta {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
}

export interface SessionRecord extends Omit<SessionMeta, 'messageCount'> {
  messages: {
    role: string
    content: string
    reasoning?: string
    toolCalls?: {
      id?: string
      name: string
      arguments: string | Record<string, unknown>
      result?: string
      ok?: boolean
      gated?: boolean
      decision?: 'approve' | 'reject'
    }[]
  }[]
}

export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
  /** True if the tool requires human approval before execution. */
  needsApproval?: boolean
}

export interface ModelInfo {
  id: string
  ownedBy?: string
}

export interface ModelsResponse {
  models: ModelInfo[]
  /** The model the backend defaults to (config.model or OPENAI_MODEL). */
  defaultModel?: string
}
