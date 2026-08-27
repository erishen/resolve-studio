# resolve-studio 架构文档

> 一份关于 `resolve-studio` 运行时设计与实现的说明，对应源码 `src/`。
> 配套图示见 `README.md` 的「架构」小节与对话中的架构图。

---

## 1. 设计哲学：everything is a plugin

`resolve-studio` 是一个用 **TypeScript** 写的 Agent 运行时，模仿 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的「**一切皆插件**」设计，底层使用 [Cordis](https://cordis.xiaoyaoji.cn/) 的依赖注入（DI）容器。

核心思想：

- **LLM 后端、工具、Agent 循环、前端（CLI / Web）全部是 Cordis 插件或服务**。
- 一份 `cordis.yml` 决定「装配哪些、怎么装配」。
- 换模型、加工具、换前端都只是改配置，**不动核心代码**。

这带来两个直接收益：

1. **可组合**——离线 demo（mock LLM）和生产（OpenAI 兼容端点）共享同一套循环与工具逻辑，差别只在 `cordis.yml` 里挂的 LLM 适配器。
2. **可测试**——核心服务（`ctx.llm` / `ctx.tools` / `ctx.agent`）与前端解耦，测试可以只加载服务和 mock LLM，无需 stdin / 网络。

---

## 2. 运行时装配（从配置到上下文）

装配链路由四个文件协作完成，全部由 `src/index.ts` 引导：

```
cordis.yml  ──▶  loader.ts  ──▶  registry.ts  ──▶  ctx.registry.plugin(...)
 (声明)          (解析 YAML)        (name→插件)          (按配置注入 ctx)
```

### 2.1 入口 `src/index.ts`

1. 用 `dotenv/config` 载入 `.env`（真实模型的密钥）。
2. 创建 Cordis 根上下文 `new Context()`，挂上官方控制台日志插件 `@cordisjs/plugin-logger-console`。
3. 解析命令行 `--config <path>`（默认 `./cordis.yml`）。
4. 调用 `loadConfig(root, configPath)` 完成装配。
5. 装配完成后打印 `composition ready`，进程的存活由**前端插件**接管（CLI 占 stdin，Web 占 HTTP 端口）。

### 2.2 配置驱动加载 `src/loader.ts`

`loadConfig` 读取 YAML，遍历插件条目（支持两种清单格式，见 §7）：

- 跳过 `disabled: true` 的条目。
- `resolvePlugin(name)` 解析顺序：**①** 在 `registry.ts` 的 `PLUGINS` 表里查**本地短名**（如 `llm-mock`）；**②** 查不到则 `await import(name)` 按 **npm 包名**动态加载（如 `@cordisjs/plugin-timer`）。导入模块优先取 `.default`，其次 `.plugin`，最后退回第一个「长得像插件」的导出——这与官方 `@cordisjs/plugin-loader` 按包名解析的思路一致。
- 对每个命中的条目调用 `await ctx.registry.plugin(plugin, entry.config ?? {})`，把配置一并注入。

> **跨生态兼容**：因为 Cordis 4 的 `Context`/`Service`/`inject`/`events` 是一套标准运行时契约，任何**只依赖 Cordis 标准 API、不依赖 `dsh-*` 服务层**的插件，无论来自 dsh 生态还是上游 Cordis 插件 registry，都能以包名直接装进本运行时，无需改代码。已用 `@cordisjs/plugin-timer`（纯 Cordis 插件，零 dsh 依赖）POC 验证：`cordis.patch.yml` 里 `name: '@cordisjs/plugin-timer'` 即可生效，`ctx.interval()` 等 mixin API 正常注入并运行。
>
> 仍保留对 demo 友好的本地 `PLUGINS` 短名表；需要 HMR / 文件监听时再换官方 loader。

### 2.3 插件注册表 `src/plugins/registry.ts`

`PLUGINS` 是一张 `name → Cordis Plugin` 的字典，目前收录 30+ 插件，分为几类：

| 类别 | name | 类型 | 真实实现 |
|------|------|------|----------|
| **核心服务** | `tools` | 服务 | `ToolRegistry` |
| | `agent` | 服务 | `AgentService` |
| | `fastpath` | 服务 | `FastPathService` |
| | `approval` | 服务 | `ApprovalService` |
| | `usage` | 服务 | `UsageService` |
| | `fs-roots` | 服务 | `FsRootsService` |
| | `skills` | 插件 | `skills` |
| | `sandbox` | 服务 | `SandboxService` |
| | `mcp` | 服务 | `McpService` |
| **LLM 适配器** | `llm-mock` | 适配器 | `llmMock` |
| | `llm-openai` | 适配器 | `llmOpenAi` |
| **基础工具** | `tool-echo` / `tool-calculator` / `tool-hello` | 工具插件 | 对应实现 |
| | `tool-read-file` / `tool-write-file` / `tool-shell` | 工具插件 | 对应实现 |
| | `tool-browser` / `tool-pick-post` / `tool-skill-run` | 工具插件 | 对应实现 |
| | `tool-analyze-dir` / `tool-analyze-code-dir` | 工具插件 | 对应实现 |
| **专用工具** | `tool-article-write` / `tool-article-validate` / `tool-article-publish` | 工具插件 | 文章流水线 |
| | `tool-article-archive` / `tool-crewai-discover` | 工具插件 | 文章管理 |
| | `tool-resume-tailor` / `tool-interview-questions` | 工具插件 | 求职辅助 |
| | `tool-crm-task` / `tool-portfolio-summary` | 工具插件 | 业务工具 |
| | `tool-pse-review` / `tool-wp-publish` | 工具插件 | 审查/发布 |
| | `tool-system-info` | 外部插件 | `@resolve-studio/plugin-system-info` |
| **前端** | `cli-chat` | 前端插件 | `cliChat` |
| | `web-server` | 前端插件 | `webServer` |
| **外部插件** | `@resolve-studio/plugin-pse` | npm 包 | PSE 三角色模式 |
| | `@resolve-studio/plugin-hello` | npm 包 | 示例插件 |

### 2.4 插件元数据 `src/plugins/util.ts`

`definePlugin(target, name, inject?)` 是统一的插件包装器，解决两个 Cordis 4 的坑：

1. **`name` 只读**：tsx/esbuild 的 `__name` helper 把 class/function 的 `name` 标成只读，Cordis 用 `Object.assign(plugin, { name })` 注入元数据时会在运行时抛 `Cannot assign to read only property 'name'`。`definePlugin` 用 `Object.defineProperty(..., { writable: true })` 把 `name` 设成可写再赋值。
2. **`inject` 形状**：Cordis 4 内部把 `inject` 存成对象（`{ agent: {} }`），直接传 `string[]` 会让 `Object.entries` 把数组下标当服务名，导致 `ctx.<service>` 访问报错。`normalizeInject` 把数组也规范化为对象形式，兼容两种写法。

---

## 3. 核心服务

多个 Cordis 服务挂在根 `ctx` 上，通过 `declare module 'cordis'` 注入类型，互相之间通过 `inject` 声明依赖。

```
            ┌─────────────────── Cordis Context (ctx) ───────────────────┐
            │                                                            │
   ctx.llm  │  ctx.tools    ctx.agent     ctx.approval    ctx.sandbox    │
   LlmService│  ToolRegistry AgentService  ApprovalService SandboxService │
   (chat/    │  (register/   (驱动循环)     (人机审批)      (OS级隔离)    │
    models)  │   schemas/call)                                            │
            │        ▲            │ uses         │            │          │
            │        │ registers  ▼              ▼            ▼          │
            │  ctx.fastpath  ctx.skills     ctx.pse       ctx.mcp        │
            │  (确定性短路)  (技能索引)    (三角色模式)   (MCP客户端)     │
            └────────────────────────────────────────────────────────────┘
```

### 3.1 `ctx.llm` — `src/services/llm.ts`

抽象契约 `LlmService extends Service`，定义两个方法：

```ts
abstract chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse>
abstract models(): Promise<ModelInfo[]>
```

具体后端由**适配器插件**提供，同一时刻只加载一个：

- `llm-mock`（`src/plugins/llm-mock.ts`）：离线。首轮强制调用配置的 `tool`（默认 `echo`），等 `role: 'tool'` 的消息出现后再产出最终回答。
- `llm-openai`（`src/plugins/llm-openai.ts`）：接 OpenAI 兼容端点（读取 `.env` 的 `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`）。

> 这与 deepseek-harness 切换 `llm-deepseek` / `llm-pi-ai` 后端的机制完全一致。

### 3.2 `ctx.tools` — `src/services/tools.ts`

`ToolRegistry` 是 Agent 的可调用工具目录：

| 方法               | 作用                           |
| ------------------ | ------------------------------ |
| `register(tool)`   | 注册 / 覆盖一个工具            |
| `unregister(name)` | 移除                           |
| `list()`           | 返回全部 `Tool`                |
| `schemas()`        | 转为喂给 LLM 的 `ToolSchema[]` |
| `get(name)`        | 按名查找                       |
| `call(name, args)` | 调用工具                       |

`call` 是容错核心：`args` 既可以是模型返回的 JSON 字符串，也可以是已解析对象；解析失败或执行抛错都会返回 `error: ...` 字符串而非抛异常，让 Agent 循环能继续（而不是整个进程崩）。每次调用都会发射 `tools/call` 事件。

### 3.3 `ctx.agent` — `src/services/agent.ts`

`AgentService` 实现经典 **LLM ⇄ tools 循环**。关键实现要点：

```ts
static inject = { tools: {}, llm: {}, fastpath: {}, approval: {}, skills: {} }
```

> **PSE 是可选依赖**：`ctx.pse` 通过可选链 `this.ctx.pse?.enabled` 访问，不列入 `inject`，这样未加载 PSE 插件时 Agent 仍能正常运行。

> **隐藏 bug 修复记录**：`AgentService` 必须声明 `inject`，否则 `run()` 内部访问 `this.ctx.tools` / `this.ctx.llm` 时，Cordis 的属性拦截器会抛 `cannot get property "xxx" without inject`。这是 Cordis 4 的强制约束——任何跨服务访问都要先登记。

`run(options)` 的逻辑：

1. **Fast Path 前置**（见 §3.4）：取最后一条 `role: 'user'`、`content` 为字符串的消息，交由 `ctx.fastpath.tryResolve` 做确定性解析。命中（`3+4` → `7`）则直接发射 `agent/done` 返回，**整个 LLM 循环被短路、零模型调用**。
2. **环境提示词注入**：在系统消息最前面注入运行环境说明（沙箱规则、文件写入路径、serena 使用注意事项等），减少 LLM 因不了解环境而产生的错误尝试。
3. **技能索引注入**：如果 `ctx.skills` 可用，把技能目录索引注入系统消息，让 LLM 知道有哪些工作流可以调用。
4. **PSE 提示词注入**：如果 `ctx.pse?.enabled`，注入 Planner-Specialist-Evaluator 三角色工作流说明，同时把最大迭代次数从 8 提升到 15（三角色需要更多轮次）。
5. **角色模板注入**：调用方传入的 `systemPrompt`（如代码审查、投资分析等角色预设）注入到最顶层，优先级最高。
6. 取 `tools`（默认 `ctx.tools.schemas()`）和 `maxIterations`（普通 8 / PSE 模式 15）。
7. 复制一份 `messages`，**不修改调用方的数组**。
8. 循环：
   - 调 `ctx.llm.chat(messages, { tools, model })` 拿下一步。
   - 有 `toolCalls` 时逐个处理：
     - 如果工具 `needsApproval`，调用 `ctx.approval.request()` 挂起等待人工审批，60s 超时自动拒绝。
     - 审批通过或无需审批的工具，调用 `ctx.tools.call`，把 `role: 'tool'` 结果塞回 `messages`。
   - 每轮发射 `agent/step`（含 assistant 消息、toolCalls、toolResults）。
   - 无 `toolCalls` 时发射 `agent/done` 并返回最终答案。
9. 超过 `maxIterations` 仍无终答，发射 `agent/done` 返回兜底文案。

### 3.4 Fast Path 服务（`ctx.fastpath`）

移植自 resolve-harness 的「能算的绝不让模型算」原则，但做了 TS 化精简：

- **独立 Cordis 服务**，含一个纯函数 `tryResolve(text): string | null`。
- 仅识别**纯算术字符**（`[0-9+\-*/().\s]`），用内置 shunting-yard 求值器（与 calculator 工具同源思路，但零耦合）。
- 命中返回结果字符串；非纯算术或求值失败返回 `null`，交回 LLM 循环。
- 这是一道**防线**而非工具替代品——`calculator` 工具仍在，模型仍可在自己的判断下调用它。

### 3.5 工具审批服务（`ctx.approval`）

`ApprovalService` 实现完整的 human-in-the-loop 审批流：

- `Tool` / `ToolSchema` 的 `needsApproval` 字段（默认 `false`）决定是否需要审批。
- Agent 循环遇到需审批的工具调用时，调用 `ctx.approval.request(call)` 挂起，返回一个 Promise。
- 前端通过 `POST /api/approval` 传入 `{ callId, decision: 'approve' | 'reject' }` 来 resolve Promise。
- 60 秒无响应自动拒绝（`DEFAULT_TIMEOUT = 60_000`），避免循环永久挂起。
- 拒绝的工具调用结果以 `error: rejected by user` 形式返回给 LLM，循环继续。
- 审批状态按 `runId` 隔离，并发会话不串台。

当前需审批的工具：`shell`（可执行任意命令）、`calculator`（演示用）。`write-file` 因已限制到 `sandbox/<task>/` 目录且有 OS 级沙箱保护，无需审批。

### 3.6 沙箱服务（`ctx.sandbox`）

`SandboxService` 提供 OS 级别的命令执行隔离：

- **macOS**：使用 `/usr/bin/sandbox-exec` + Seatbelt profile，默认拒绝所有，按需放行文件读写和网络。
- **Linux**：使用 `bwrap`（bubblewrap），需要系统安装。
- **其他平台**：降级为直接执行（带警告）。

`wrapShell(command)` 方法返回 `{ cmd, args }`，把原始命令包装成沙箱执行命令。可写目录白名单：当前工作目录 + 系统临时目录。网络访问由 `SANDBOX_ALLOW_NETWORK` 控制。

`tool-shell` 插件通过可选链访问 `ctx.sandbox`（`sandboxSvc?.enabled ? wrapShell() : 直接执行`），沙箱服务未加载时自动降级。

### 3.7 PSE 三角色服务（`ctx.pse`）

`PseService`（外部包 `@resolve-studio/plugin-pse`）实现 Planner-Specialist-Evaluator 工作流：

- 从 `souls/` 目录加载三个角色的 `SOUL.md` 定义（planner / specialist / evaluator）。
- `enabled` 状态可通过 `.env`（`PSE_ENABLED=true`）或运行时 API（`POST /api/pse`）切换。
- `systemPrompt()` 生成三角色工作流说明，注入 Agent 循环的系统消息。
- PSE 模式下 Agent 循环上限自动提升到 15 轮。

### 3.8 MCP 客户端服务（`ctx.mcp`）

`McpService` 连接外部 MCP Server，把其工具动态注册到 `ctx.tools`：

- 支持 stdio（`npx` / `uv` 等）和 http（Streamable HTTP）两种传输。
- 服务器配置来自 `cordis.yml` 的 `mcp.config.servers` 和运行时持久化文件 `.data/mcp-servers.json`。
- 每个服务器的工具以 `<serverId>:<toolName>` 前缀注册（如 `fs:read_file`、`serena:replace_content`）。
- 审批策略支持工具级粒度：`false`（全免审批）、`{ allow: [...] }`（白名单自动通过）、`{ deny: [...] }`（黑名单仍需审批）。
- 连接失败的服务器记录 `error` 状态，不影响其他服务器和整个运行时。

---

## 4. 事件总线

Cordis 的 `ctx.events` 是连接「循环内部」与「前端观察者」的**解耦层**。所有事件类型在 `declare module 'cordis' { interface Events }` 里声明：

| 事件                | 载荷                         | 发射方         |
| ------------------- | ---------------------------- | -------------- |
| `agent/step`        | `AgentStep`                  | `AgentService` |
| `agent/tool-call`   | `ToolCall`                   | `AgentService` |
| `agent/tool-result` | `{ call, result, ok }`       | `AgentService` |
| `agent/done`        | `string`（最终答案）         | `AgentService` |
| `agent/approval-request` | `{ callId, tool, args }` | `AgentService` |
| `llm/stream`        | `{ delta, reasoning }`       | `LlmService`   |
| `llm/usage`         | `{ promptTokens, completionTokens }` | `LlmService` |
| `tools/call`        | `{ name, args, ok, result }` | `ToolRegistry` |
| `mcp/connected`     | `{ serverId, toolCount }`    | `McpService`   |
| `pse/toggled`       | `{ enabled }`                | `PseService`   |

设计意图：**前端不需要知道循环内部细节**，只要监听这些事件就能流式渲染进度。CLI、Web、测试都是同一套事件的消费者。

---

## 5. 两种前端（互斥）

前端都是「挂在 `ctx` 上的插件」，与 `cli-chat` / `web-server` 平级。二者**互斥**——不能同时挂，否则 REPL 会抢 stdin。

### 5.1 `cli-chat` — `src/plugins/cli-chat.ts`

最小的「前端」：`readline` 监听 stdin，每行喂给 `ctx.agent.run`，监听 `agent/tool-call` / `agent/tool-result` 打印进度，监听 `/exit` 退出。维护一个 `history` 数组实现多轮对话。

### 5.2 `web-server` — `src/plugins/web-server.ts`

基于 Node 内置 `http`（零额外依赖）的 HTTP 桥：

| 端点          | 方法 | 作用                           |
| ------------- | ---- | ------------------------------ |
| `/health`     | GET  | 健康检查（uptime/内存/工具数/MCP数） |
| `/api/tools`  | GET  | 返回 `ctx.tools.schemas()`     |
| `/api/models` | GET  | 返回 `ctx.llm.models()`        |
| `/api/skills` | GET  | 返回技能列表                   |
| `/api/chat`   | POST | `{ messages, model, systemPrompt }` → SSE 流 |
| `/api/approval` | POST | `{ callId, decision }` 审批工具调用 |
| `/api/sessions` | GET/POST | 会话 CRUD（持久化） |
| `/api/sessions/:id` | GET/DELETE | 单会话读取/删除 |
| `/api/usage`  | GET  | token/费用统计（全局或按会话） |
| `/api/mcp`    | GET/POST/DELETE | MCP server 管理 |
| `/api/pse`    | GET/POST | PSE 模式状态查询/切换 |
| `/api/workspace/report` | GET | 工作区项目分析报告 |

`POST /api/chat` 是核心：

1. 解析 body，校验 `messages` 非空数组。
2. 握手 `text/event-stream`（含 `Cache-Control: no-transform`、`X-Accel-Buffering: no` 防代理缓冲）。
3. 为每个请求挂**独立的短时监听器**（`ctx.events.on` 返回的 disposer），把 `tool-call` / `tool-result` / `step` 事件转成 SSE `data:` 帧。
4. `await ctx.agent.run(...)`，结束发 `done`，异常发 `error`，`finally` 里 `cleanup()` 拆除监听器并 `res.end()`。

> **并发安全**：监听器是「每请求独立」的，请求结束即回收，多个浏览器会话不会串台。Cordis 的 `events` 没有 `off`，所以用 `on` 返回的 disposer 来注销。

---

## 6. Web 前端（React + Vite）

`web/` 是独立的 React 18 + Vite 5 + TypeScript 应用，与后端 `web-server` 通过 SSE 对接：

```
浏览器 (web/, :5173)
   │  fetch POST /api/chat  ← 解析 SSE 帧
   ▼
Vite dev server (proxy /api → :8787)
   ▼
web-server 插件 (:8787)  ──监听 agent/* 事件──▶ ctx.agent.run()
```

- `apps/web/src/api.ts`：SSE 客户端，用 `fetch` + `ReadableStream` 逐帧解析 `event:` / `data:`。
- `apps/web/src/App.tsx`：对话状态机，顶部导航栏（模型选择、角色模板、PSE 开关、更多菜单），把 `step` / `tool-call` / `tool-result` / `done` 事件归并成 `UIMessage`。
- `apps/web/src/MessageList.tsx`：消息列表，thinking→工具卡→总结的渲染流程。
- `apps/web/src/ToolCallCard.tsx`：工具调用卡片（名称、入参、结果、审批按钮、成功/失败状态）。
- `apps/web/src/Composer.tsx`：输入框，支持示例问题快捷插入。
- `apps/web/src/WorkspaceView.tsx`：工作区视图，展示项目卡片和快捷任务。
- `apps/web/src/FilePreview.tsx`：Markdown 文件预览弹窗。
- `apps/web/src/prompts.ts`：角色模板定义（通用助手、代码审查、投资分析、技术写作、极简回复、调试专家）。
- `apps/web/src/examples.ts`：示例问题库，按分类（文章、投资、面试、CRM、其他）组织。
- `vite.config.ts`：`server.host = '127.0.0.1'`（避免默认绑 `::1` 导致 `127.0.0.1` 访问空），`proxy` 把 `/api` 反代到后端 `:8787`。

> 生产构建（`make build-web` → `web/dist/`）是纯静态文件，托管到任意地方只需把 `/api` 反代到后端 `:8787`。

---

## 7. 配置组合矩阵

四个 `cordis.yml` 变体决定「挂哪个 LLM + 哪个前端」：

| 配置文件                | LLM          | 前端         | 用途           |
| ----------------------- | ------------ | ------------ | -------------- |
| `cordis.yml`（默认）    | `llm-mock`   | `cli-chat`   | 离线 REPL demo |
| `cordis.web.yml`        | `llm-mock`   | `web-server` | 离线 Web demo  |
| `cordis.openai.yml`     | `llm-openai` | `cli-chat`   | 真实模型 REPL  |
| `cordis.openai.web.yml` | `llm-openai` | `web-server` | 真实模型 Web   |

示例（默认）：

```yaml
plugins:
  - { name: tools }
  - { name: agent }
  - { name: fastpath }
  - { name: approval }
  - { name: fs-roots }
  - { name: skills }
  - { name: sandbox }
  - { name: mcp }
  - { name: llm-mock, config: { tool: echo } }
  - { name: tool-echo }
  - { name: tool-calculator }
  - { name: cli-chat }
```

---

## 8. 实现要点与坑

1. **Cordis 4 的 `inject` 必须声明跨服务访问**（`AgentService.static inject = { tools:{}, llm:{} }`、函数插件第三个参数 `['tools']`）。漏了就抛 `cannot get property "xxx" without inject`。
2. **可选服务不要列入 `inject`**：PSE、sandbox 等可选服务用可选链 `ctx.pse?.enabled` 访问，不列入 `inject`，否则未加载该插件时整个服务初始化失败。
3. **tsconfig 必须用 `module: ESNext` + `moduleResolution: Bundler`**：改用 `NodeNext` 时 Cordis 的 `exports` 未暴露 `./context` 子路径，TS 无法解析 `Context` 的 class 实现，报 `'Context' only refers to a type`。
4. **关闭 `declaration`**：Cordis `Service` 用了私有 symbol 属性，匿名 class 导出 `.d.ts` 会报 `cannot be named`。运行期用 tsx 直接跑 `.ts`，无需声明文件。
5. **API 调用走属性式**（`ctx.registry.plugin` / `ctx.events.on/emit`），不依赖方法式 augmentation。
6. **SSE 用「每请求独立短时监听器」**，请求结束 `finally` 回收，避免并发会话串台。
7. **包管理器固定 pnpm**；pnpm 9 lockfile 是 registry-agnostic 的（只记 integrity 哈希 + 包名版本，无 tarball host 写死），镜像切换无需 sed 改 lockfile。
8. **Vite 默认绑 `::1`**，本地 `127.0.0.1:5173` 访问会空——必须在 `vite.config.ts` 显式设 `server.host = '127.0.0.1'`。
9. **macOS Seatbelt 沙箱需要 sysctl 和 iokit 权限**：否则 Node.js 的 `os` 模块会崩溃（`Assertion failed: (args.Length()) >= (1)`），profile 中必须包含 `(allow sysctl*)` 和 `(allow iokit-open)`。
10. **write-file 路径规范化**：LLM 可能冗余写入 `sandbox/<task>/file.py`，工具会自动去除前缀 `sandbox/` 和 `<task>/`，避免路径嵌套成 `sandbox/<task>/sandbox/<task>/file.py`。

---

## 9. 扩展指南

- **加工具**：`src/plugins/` 里写 `definePlugin((ctx) => ctx.tools.register({...}), 'tool-xxx', ['tools'])`，并在 `registry.ts` 的 `PLUGINS` 与对应 `cordis.yml` 登记。或用 `make new-plugin name=x` 脚手架生成独立插件包。
- **加 LLM 后端**：继承 `LlmService`，实现 `chat()` / `models()`，用 `definePlugin` 注册，再在 `cordis.yml` 替换 `llm-*` 条目。
- **加服务**：`src/services/` 新 Service + `declare module 'cordis'` + 需要处 `inject`（可选服务用可选链访问，不列入 inject）。
- **加技能**：在外部 `harness-skills/skills/<name>/SKILL.md` 写指令包，通过 `HARNESS_SKILLS_DIR` 环境变量指定目录，重启即入索引。
- **加 MCP server**：在 `cordis.yml` 的 `mcp.config.servers` 或 `.data/mcp-servers.json` 添加条目，支持 stdio 和 http 两种传输。
- **换前端**：写一个新的「监听 `agent/step` 等事件」的插件即可（如 Web / A2A 前端），与 `cli-chat` 平级、互斥挂载。

---

## 10. 一键运行

包管理器固定 **pnpm**，常用任务收敛在 `Makefile`（`make help` 查看）：

| 命令                           | 作用                                                             |
| ------------------------------ | ---------------------------------------------------------------- |
| `make install`                 | 装后端 + 前端依赖                                                |
| `make check`                   | `typecheck`(src) + `test`                                        |
| `make build`                   | 编译后端到 `dist/`                                               |
| `make build-web`               | 构建前端到 `web/dist/`                                           |
| `make dev`                     | 单终端起后端（mock）+ 前端 dev，开 `:5173` 即可聊，`Ctrl-C` 退出 |
| `make dev-real`                | 同上，但后端接真实模型（`cordis.openai.web.yml`）                |
| `make chat` / `make chat-real` | 起 CLI（mock / 真实模型）                                        |
| `make clean`                   | 清构建产物                                                       |
