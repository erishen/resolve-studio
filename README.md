# resolve-studio

English | [中文](README.zh.md)

A **TypeScript** Agent runtime that mimics the "**everything is a plugin**" design of [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness), built on the [Cordis](https://cordis.xiaoyaoji.cn/) dependency-injection container.

Core idea: the LLM backend, tools, agent loop, approvals, skills, and the frontend (CLI/Web) are all Cordis **plugins/services**, composed by a set of `cordis*.yml` files. Switching models, adding tools, or swapping the frontend is just a config change — no core code is touched.

> See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for architecture details (with an interview-prep guide per module); see [docs/demo-prompts.md](docs/demo-prompts.md) for example prompts.

## Feature overview

| Capability                  | Description                                                                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Agent loop**              | LLM ⇄ tool multi-round loop (8 normal / 15 in PSE mode), streaming, event-driven                                                                                                           |
| **PSE three roles**         | Planner-Specialist-Evaluator workflow, one-click toggle in the UI, roles loaded from the souls directory                                                                                   |
| **OS-level sandbox**        | shell commands run inside a macOS Seatbelt / Linux bwrap sandbox, with restricted writable dirs                                                                                            |
| **Sandboxed workspace**     | write-file defaults to `sandbox/<task>/`, per-task directory isolation, paths auto-normalized                                                                                              |
| **Fast Path**               | deterministic inputs like arithmetic get answered with **zero model calls** (`3+4` → `7`)                                                                                                  |
| **Tool approval**           | `needsApproval` tools pause before execution; Approve/Reject in the UI, auto-reject on timeout (60s)                                                                                       |
| **Streaming output**        | SSE `delta` token-by-token typing; DeepSeek-style `reasoning_content` shown as a separate thinking block                                                                                   |
| **Web exploration**         | Playwright drives the system Chrome (zero download): `browser-open` (extract article) / `browser-screenshot`                                                                               |
| **Skills**                  | external `resolve-skills/skills/<name>/SKILL.md` instruction packs, indexed into the system prompt                                                                                         |
| **Session persistence**     | conversation history (with tool cards and thinking blocks) persisted to JSON, restored on refresh                                                                                          |
| **Task modes**              | professional tool-sets auto-matched to intent (business tasks + capability scopes); a task pinned from the in-chat task cards whitelists the model's tools and filters the example prompts |
| **Background jobs**         | managed on the dedicated 任务 (Tasks) tab; detached long-running runs in a per-job sandbox workspace: tool whitelist, no approval gate, artifact browsing, and one-click resume            |
| **Markdown rendering**      | tables / code blocks / lists (react-markdown + remark-gfm)                                                                                                                                 |
| **Plugin scaffolding**      | `make new-plugin name=x` generates a plugin package and wires it up in one step                                                                                                            |
| **Cross-ecosystem loading** | dynamically load pure Cordis plugins by npm package name (dsh `cordis.patch.yml` format)                                                                                                   |
| **MCP integration**         | connect any MCP Server (stdio/http), tools registered as `<id>:<tool>`, approval on by default                                                                                             |
| **Specialized toolset**     | 60+ tools for article writing/publishing, resume tailoring, interview questions, CRM tasks, portfolio summary, hot-news content, project discovery, and more                               |

## Quick start

```bash
pnpm install
make dev            # single terminal: backend (real model, needs .env + OPENAI_*) + frontend dev → opens http://127.0.0.1:5173
make dev-mock       # same, but offline mock (no key required) → opens http://127.0.0.1:5173
```

CLI version (no browser):

```bash
pnpm run chat                # mock LLM, offline
pnpm run chat -- --config cordis.openai.yml   # real model
```

## Environment variables

Copy `.env.example` to `.env` and fill in as needed:

| Variable                        | Description                                            | Default                       |
| ------------------------------- | ------------------------------------------------------ | ----------------------------- |
| `OPENAI_BASE_URL`               | OpenAI-compatible API base URL                         | —                             |
| `OPENAI_API_KEY`                | API Key                                                | —                             |
| `OPENAI_MODEL`                  | Default model                                          | —                             |
| `WORKSPACE_OUT`                 | Workspace scan report output directory                 | `<cwd>/workspace-analysis`    |
| `SERENA_UV`                     | path to the `uv` binary (for serena code analysis)     | `uv` (PATH lookup)            |
| `HARNESS_EXTRA_ROOTS`           | extra allowed filesystem roots (comma-separated)       | —                             |
| `HARNESS_SHELL_ALLOW_TRAVERSAL` | set to `1` to allow shell tool directory traversal     | `0`                           |
| `HARNESS_PRICES`                | custom model price table (JSON)                        | built-in price table          |
| `SANDBOX_ENABLED`               | enable OS-level sandbox (macOS Seatbelt / Linux bwrap) | `false`                       |
| `SANDBOX_ALLOW_NETWORK`         | allow network access inside the sandbox                | `true`                        |
| `PSE_ENABLED`                   | enable PSE three-role mode                             | `false`                       |
| `PSE_SOULS_DIR`                 | PSE role definition directory                          | `HARNESS_SKILLS_DIR/../souls` |
| `CREWAI_PSE_DIR`                | crewai-pse project path                                | auto-derived relative path    |
| `AUTOGEN_PSE_DIR`               | autogen-pse project path                               | auto-derived relative path    |
| `LLAMAINDEX_PSE_DIR`            | llamaindex-pse project path                            | auto-derived relative path    |
| `LANGGRAPH_PSE_DIR`             | langgraph-pse project path                             | auto-derived relative path    |

> All path-style configs support environment-variable overrides, so the project can be migrated across machines without touching code.

## Config-driven composition

Four configs = CLI/Web × mock/real model:

| Config                  | LLM               | Frontend |
| ----------------------- | ----------------- | -------- |
| `cordis.yml`            | mock              | CLI REPL |
| `cordis.web.yml`        | mock              | Web UI   |
| `cordis.openai.yml`     | OpenAI-compatible | CLI REPL |
| `cordis.openai.web.yml` | OpenAI-compatible | Web UI   |

`loader.ts` parses the `plugins` list and maps each `name` to either a local plugin in `src/plugins/registry.ts` (short name) or a dynamic `import()` (npm package name). `cordis.patch.yml` follows dsh's `- insert:` manifest format, loading packages like `@cordisjs/plugin-timer` and `@resolve-studio/plugin-hello` by name.

## Runtime services (ctx.*)

| Service          | Responsibility                                                                          |
| ---------------- | --------------------------------------------------------------------------------------- |
| `ctx.llm`        | chat-completion contract: `chat` + `chatStream` (streaming, fallback by default)        |
| `ctx.tools`      | tool registry (register/list/schemas/call); exceptions become `error:` prefix, no crash |
| `ctx.agent`      | agent loop: Fast Path → skill injection → LLM ⇄ tools (incl. approval pause)            |
| `ctx.approval`   | human-in-the-loop approval: pause / external resolve / auto-reject on timeout           |
| `ctx.fastpath`   | deterministic pre-processor (arithmetic short-circuit)                                  |
| `ctx.skills`     | skill index (scans external `resolve-skills/skills/*/SKILL.md`, parses frontmatter)     |
| `ctx.tasks`      | professional tool-set registry: business tasks + capability scopes, intent matching     |
| `ctx.jobs`       | detached long-running runs: per-job workspace, tool whitelist, no approval, resume      |
| `ctx.pse`        | PSE three-role mode: toggle state, role loading, system-prompt injection                |
| `ctx.sandbox`    | OS-level sandbox: Seatbelt/bwrap profile generation, shell command wrapping             |
| `ctx.mcp`        | MCP client: connect/disconnect servers, dynamic tool registration                       |
| `ctx.systemInfo` | runtime diagnostics (memory/CPU/uptime/platform, periodic collection + event emit)      |

## Security & sandboxing

resolve-studio provides multiple layers of safety to stop the LLM from accidentally damaging the system:

| Layer                   | Mechanism                    | Description                                                                                   |
| ----------------------- | ---------------------------- | --------------------------------------------------------------------------------------------- |
| **OS-level sandbox**    | macOS Seatbelt / Linux bwrap | shell commands can only write to the working directory + system temp dir, no access elsewhere |
| **Path guard**          | fs-roots service             | write-file is limited to a whitelist of directories; out-of-bounds paths are rejected         |
| **Sandboxed workspace** | `sandbox/<task>/`            | write-file relative paths auto-write into a per-task isolated directory, paths auto-deduped   |
| **Job workspace**       | `.data/jobs/<id>/workspace/` | each background job runs in its own dir (write-file/shell anchor there) + a dedicated profile |
| **Human approval**      | approval service             | high-risk tools like shell require human confirmation before running; auto-reject after 60s   |
| **MCP isolation**       | fs MCP restriction           | the fs MCP server only exposes the sandbox directory, not the whole filesystem                |

Enable the sandbox: set `SANDBOX_ENABLED=true` in `.env`.

## PSE three-role mode

The Planner-Specialist-Evaluator workflow lets the LLM divide work by role to tackle complex tasks:

- **Planner**: plans and decomposes the task, does not write code itself
- **Specialist**: executes the concrete subtasks
- **Evaluator**: independently accepts the result, outputs PASS/PARTIAL/FAIL/BLOCKED

Toggle it from the top of the UI, or set `PSE_ENABLED=true` in `.env`. In PSE mode the agent-loop cap is automatically raised to 15 rounds.

## Built-in tools (60+, ⚠ = needs approval)

Basic tools:

```
hello · echo · calculator⚠ · read-file · write-file · shell⚠
browser-open · browser-screenshot · pick-post · system-info · skill-run
```

Specialized tools (articles / investing / interviews / CRM / hot-news):

```
article-write · article-validate · article-publish · article-archive · article-discover
resume-tailor · interview-questions · crm-task · portfolio-check · pse-review
wp-publish · crewai-publish · crewai-discover
hot-news-fetch · hot-news-topics · hot-news · hot-news-check
```

Read operations need no approval (browser/pick-post/read-file/system-info); writes and executions must pass approval (shell/calculator are demos). Tools from an **MCP server** (after configuring `servers:`) are appended as `<serverId>:<toolName>` and, by default, also require approval.

### Connect an MCP server (example)

```yaml
# mcp entry in cordis.web.yml
- id: mcp
  name: mcp
  config:
    servers:
      - id: fs
        transport: stdio
        command: npx
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/allowed/dir']
      - id: remote
        transport: http
        url: https://example.com/mcp
        approval: false # read-only server can disable approval
```

After connecting, tools like `fs:read_file` and `fs:list_directory` appear in the tool list and can be called directly by the model.

## Scripts

The package manager is pinned to **pnpm**; common tasks live in the `Makefile` (`make help`):

| Command                               | Purpose                                           |
| ------------------------------------- | ------------------------------------------------- |
| `make install`                        | install all dependencies                          |
| `make check`                          | typecheck + test (**94 test cases**)              |
| `make lint` / `make lint-fix`         | ESLint check / auto-fix                           |
| `make format` / `make format-check`   | Prettier format / format check                    |
| `make build` / `make build-web`       | build backend / frontend                          |
| `make dev` / `make dev-mock`          | single terminal backend+frontend (real / mock)    |
| `make chat` / `make chat-real`        | launch the CLI                                    |
| `make new-plugin name=x`              | scaffold a new plugin package                     |
| `make docker-up` / `make docker-down` | Docker Compose up/down (backend + nginx frontend) |
| `make clean`                          | clean build artifacts                             |
| `make secret-scan`                    | run gitleaks over the whole repo (local audit)    |
| `make hook-init`                      | enable the local pre-commit secret-scanning hook  |

## Web UI (React + Vite, apps/web/)

The backend `web-server` plugin (zero-dependency, Node built-in `http`) pushes `agent/*` events to the frontend over **SSE**:

- `GET /health` → health check (uptime / memory / tool count / MCP server count)
- `POST /api/chat` → SSE: `step / tool-call / tool-result / approval-request / delta / reasoning / usage / done / error`
- `GET /api/tools` · `GET /api/models` · `GET /api/skills`
- `GET /api/tasks` · `POST /api/tasks/match` → professional task/scope catalog + intent match
- `POST/GET /api/jobs` · `GET/DELETE /api/jobs/:id` → background jobs CRUD
- `POST /api/jobs/:id/cancel` · `POST /api/jobs/:id/resume` → stop / resume a job
- `GET /api/jobs/:id/stream` → SSE re-attach: snapshot + live events
- `GET /api/jobs/:id/files` → list the job's workspace artifacts
- `POST /api/approval` (`{callId, decision}`)
- `GET/POST /api/sessions` · `GET/DELETE /api/sessions/:id` (persistence)
- `GET /api/usage?sessionId=<id>` → global or per-session token/cost statistics

Frontend structure: `api.ts` (SSE client) · `App.tsx` (layout + composition) · `hooks/useChat.ts` (message state machine + streaming + approval) · `hooks/useSessions.ts` (session CRUD + auto-save) · `hooks/useMcp.ts` (MCP server management) · `hooks/useJobs.ts` (job list + live detail) · `MessageList.tsx` (thinking → tool card → summary + in-chat task cards) · `ToolCallCard.tsx` (tool card + approval button) · `JobsPanel.tsx` (background-job manager) · `Composer.tsx` · `ErrorBoundary.tsx` (root-level error boundary).

## Background jobs (detached long-running tasks)

Long-running work (multi-step analysis, article pipelines, report generation) can run as a **background job** — the `jobs` plugin runs `ctx.agent.run()` detached from the HTTP request, so closing the browser tab won't kill it. Each job gets:

- **capped concurrency** — the `jobs` plugin runs at most `maxConcurrent` jobs at once (default `3`); excess jobs stay `queued` in FIFO order until a slot frees, so heavy PSE/LLM pipelines don't exhaust memory or hit provider rate limits;
- **PSE on by default** — background jobs run in Planner-Specialist-Evaluator three-role mode even when interactive chat keeps the global PSE flag off (override per run via `agent.run({ pse })`);
- **its own workspace** `.data/jobs/<id>/workspace/` — write-file / read-file / shell anchor relative paths and the shell cwd there, and it is added as an extra sandbox writable root (per-run Seatbelt profile);
- **a tool whitelist** (`includeTools` / `excludeTools`) so the job only sees the tools its task needs;
- **no approval gate** (`skipApproval`) — unattended runs never block on human approval;
- **live, re-attachable progress** — events stream over SSE (`/api/jobs/:id/stream`) and are persisted to a SQLite database (`.data/jobs/jobs.db`), so you can close the tab and re-attach later;
- **intermediate artifacts** — `/api/jobs/:id/files` lists everything written to the workspace, previewable in the UI;
- **resume** — the full message transcript is persisted; a failed / cancelled / restarted job can be resumed (`POST /api/jobs/:id/resume`) from where it left off against the same workspace.

Create one from the 任务 tab → 后台长时任务, or via `POST /api/jobs` (`{ prompt, taskId?, includeTools?, excludeTools? }`).

## Extending

See [docs/plugin-authoring.md](docs/plugin-authoring.md) for a step-by-step guide from skeleton to a complete plugin.

- **Add a tool**: `make new-plugin name=x` to generate a package, or write `tool-x.ts` + registry + yml under `src/plugins/`
- **Add a skill**: drop an external `resolve-skills/skills/<name>/SKILL.md` (frontmatter: name/description + steps), point to it via the `HARNESS_SKILLS_DIR` env var; it is indexed on restart
- **Add an LLM backend**: extend `LlmService` and implement `chat` (+ optional `chatStream`)
- **Add a service**: new Service in `src/services/` + `declare module 'cordis'` + `inject` where used
- **External plugins**: follow the pure Cordis contract (only `import 'cordis'`), publish to npm by package name, and reference directly in `cordis.yml`

## Implementation notes

- Cordis 4's `Context` is injected via `declare module './context'`; tsconfig must use `module: ESNext` + `moduleResolution: Bundler`.
- **Cross-service access must declare `inject`**: otherwise Cordis's property interceptor throws `cannot get property "xxx" without inject`. Function plugins use `definePlugin(fn, name, ['tools'])`; Services use `static inject`.
- Plugin functions return a **disposer** for cleanup (close browser / close server) — do not use `ctx.on('dispose')` (not in the event type).
- `definePlugin` uses `Object.defineProperty` to make `name` writable, working around tsx/esbuild's read-only restriction on class/function `name`.
- SSE uses a per-request short-lived listener (`ctx.events.on` returns a disposer) that is reclaimed when the request ends, so concurrent sessions do not cross-talk.
- pnpm workspace caveat: tools used by root CLI commands (tsx, etc.) must be declared at root; `@types/*` referenced by a sub-package's tsconfig must be declared in its own devDeps.
- Background jobs forward a per-run `workspace` through the tool execution context (write-file / read-file / shell anchor relative paths & the shell cwd there) and add it as an extra sandbox writable root (Seatbelt profiles are cached per root-set).
- `skipApproval` (jobs) short-circuits the approval gate so unattended runs never block; job transcripts are built from `agent/step` events so a failed run can be resumed against the same workspace.
- Ctrl+C exits on the first press: the CLI aborts the in-flight run and exits 130; the web-server SIGINT handler closes the server and exits (a bare `server.close()` would keep the process alive).

## Engineering / tooling

- **ESLint** (flat config) + **Prettier**: `pnpm run lint` / `pnpm run format`, configs at root `eslint.config.js` / `.prettierrc.json`
- **EditorConfig**: unified indentation / line endings / encoding
- **CI** (GitHub Actions): `.github/workflows/ci.yml` runs typecheck + test + build + lint + format-check on every push/PR; a `secret-scan` job runs [gitleaks](https://github.com/gitleaks/gitleaks) (config `.gitleaks.toml`) and uploads the SARIF report to the Security tab
- **Secret scanning**: `make secret-scan` scans the whole repo locally; `make hook-init` enables a pre-commit hook (`.githooks/pre-commit`) that blocks staged secrets via `gitleaks protect --staged`
- **Docker**: multi-stage backend image build; `docker-compose.yml` brings up backend + nginx frontend (`/api` reverse-proxied to the backend, with SSE support)

```bash
# bring up containers locally in one step
make docker-up        # backend :8787 + frontend :5173
make docker-down
```

## Related Articles

- [Cordis Plugin-Based Agent Runtime: Using a DI Container to Make LLM Backends, Tools, and Approval Flows All Configurable](https://erishen.cn/resolve_studio-en/)
