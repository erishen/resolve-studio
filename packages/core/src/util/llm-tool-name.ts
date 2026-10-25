/**
 * LLM tool-name mapping — internal names ↔ provider-safe spellings.
 *
 * Why this exists: OpenAI-compatible `/chat/completions` endpoints validate
 * every `tools[].function.name` against `^[a-zA-Z0-9_-]+$`. Our internal tool
 * namespace uses `<serverId>:<toolName>` for MCP tools (see `plugins/mcp.ts`),
 * so any run whose tool whitelist contains an MCP server prefix (e.g. `fs` —
 * present in 8 of the 9 task whitelists) used to fail with:
 *
 *   400 invalid tool/function name (must match ^[a-zA-Z0-9_-]+$):
 *   Invalid 'tools[10].function.name': string does not match pattern
 *
 * Internal names stay canonical — approval policies (`{ allow: ['fs:read_file'] }`),
 * the tool registry, the web UI and the test-suite all speak `id:tool`. This
 * module only re-spells names at the adapter boundary:
 *   - request:  `fs:read_file`  → `fs__read_file`
 *   - response: `fs__read_file` → `fs:read_file`
 */

/** Provider-safe spelling of a single internal tool name. */
export function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, '__')
}

/**
 * Bidirectional map for one request's tool set. Built once per LLM call from
 * the schemas being sent. Collisions (two internal names sharing one safe
 * spelling, e.g. `a:b` and `a__b`) are disambiguated with a numeric suffix so
 * the reverse map stays injective.
 */
export class ToolNameMap {
  private readonly toLlmName = new Map<string, string>()
  private readonly toInternalName = new Map<string, string>()

  constructor(names: Iterable<string>) {
    for (const name of names) {
      const base = sanitizeToolName(name)
      let safe = base
      let n = 2
      while (this.toInternalName.has(safe)) {
        safe = `${base}_${n++}`
      }
      this.toLlmName.set(name, safe)
      this.toInternalName.set(safe, name)
    }
  }

  /** Internal name → provider-safe spelling (unknown names are sanitized). */
  toLlm(name: string): string {
    return this.toLlmName.get(name) ?? sanitizeToolName(name)
  }

  /** Provider-safe spelling → internal name (unknown names pass through). */
  toInternal(name: string): string {
    return this.toInternalName.get(name) ?? name
  }
}
