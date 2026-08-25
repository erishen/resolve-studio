# agent-harness 架构

一个用 TypeScript 写的 Agent 运行时，模仿 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的「everything is a plugin」设计，底层用 [Cordis](https://cordis.xiaoyaoji.cn/) 依赖注入容器。**LLM 后端、工具、Agent 循环、前端全部是插件**，由一份 `cordis*.yml` 组合驱动。

## 系统总览

```
cordis.web.yml ──▶ loader ──▶ ctx.registry.plugin(...)   （按配置装配）
                                    │
      ┌──────────────┬──────────────┼───────────────┬─────────────┐
      ▼              ▼              ▼               ▼             ▼
  ctx.llm        ctx.tools      ctx.agent      ctx.approval   ctx.skills
  (LlmService)  (ToolRegistry)  (AgentService)  (Approval)    (Skills)
  ├ llm-mock     ├ echo          └ 驱动 loop：    └ 人机审批      └ skills/ 目录
  └ llm-openai   ├ calculator⚠      LLM ⇄ tools ⇄ events   索引注入 prompt
                 ├ read-file       （含流式 delta）
                 ├ write-file⚠
                 ├ shell⚠
                 ├ browser-open / browser-screenshot
                 ├ pick-post
                 └ hello
                                    │
              ┌─────────────────────┴─────────────────────┐
        cli-chat (REPL, cordis.yml)          web-server (:8787, SSE → React)
```

## 目录结构

```
agent-harness/
├── cordis*.yml                 # 装配配置（4 个：CLI/Web × mock/真实模型）
├── cordis.patch.yml            # dsh 兼容格式：按 npm 包名加载插件
├── skills/                     # 技能库：skills/<name>/SKILL.md (+ scripts/)
├── packages/
│   ├── core/                   # 运行时（services + plugins + loader）
│   │   ├── src/services/       #   核心服务（agent/tools/llm/approval/fastpath/skills）
│   │   ├── src/plugins/        #   插件（web-server/cli-chat/工具们/llm 适配器）
│   │   ├── src/loader.ts       #   配置 → 插件装配
│   │   └── tests/              #   21 个测试
│   ├── plugin-hello/           # 独立插件包（跨生态演示）
│   └── ...
└── apps/web/                   # React + Vite 前端
```

## 核心机制

### 1. 装配：配置驱动一切

- `cordis*.yml`：每行 `{id, name, config}`，`name` 映射到 `src/plugins/registry.ts` 的本地插件。
- `cordis.patch.yml`：dsh 兼容格式，`name` 是 **npm 包名**（如 `@cordisjs/plugin-timer`），loader 动态 `import()` 加载——同一个插件可发布到 npm 被任何 Cordis 运行时加载。
- 换模型、加工具、换前端 = 改配置，不动核心代码。

### 2. 服务 vs 工具 vs 技能（可见性分层）

| 层 | 注册处 | UI 可见性 | 例子 |
|----|--------|----------|------|
| **服务** | `ctx.xxx = new Service()` | 一般不可见（通过事件间接影响 UI） | approval（事件→审批按钮）、skills（索引→prompt） |
| **工具** | `ctx.tools.register(...)` | 工具列表 + 消息流工具卡 | echo、browser-open |
| **技能** | `skills/<name>/SKILL.md` | 侧栏 chip（可展开描述） | code-review、post-comment |

工具 = 给模型的可调用函数；服务 = 插件间的内部 API；技能 = 给模型的「说明书」（模型读 SKILL.md 后照做，可带 scripts/ 脚本由 shell 执行）。

### 3. 服务（src/services/）

| 服务 | 职责 | 关键设计 |
|------|------|---------|
| `ctx.llm` | 聊天补全契约 | 抽象类；`chat` + `chatStream`（默认 fallback 到 chat 一次吐全量） |
| `ctx.tools` | 工具注册表 | `register/list/schemas/call`；`call` 捕获异常返回 `error:` 前缀，循环不崩 |
| `ctx.agent` | Agent 循环 | 见下方时序；`static inject` 声明依赖（Cordis 严格校验） |
| `ctx.approval` | 人机审批 | `request(call)` 挂起 Promise + emit 事件；`resolve(callId, decision)` 外部触发；**超时自动拒绝**（默认 60s） |
| `ctx.fastpath` | 确定性预处理器 | 纯算术短路：能算的绝不让模型算（零模型调用） |
| `ctx.skills` | 技能索引 | 扫描 `skills/*/SKILL.md`（frontmatter 解析）；`indexText()` 供注入 |

另有一个**连接器插件**（非服务）：`plugins/mcp.ts` 用官方 SDK 连接 MCP Server（stdio/http），把 server 的工具动态注册进 `ctx.tools`（前缀 `<serverId>:<toolName>`，默认 `needsApproval: true`，可 `approval: false` 关闭）；连接失败仅告警不崩组合。

### 4. Agent 循环时序（一次 chat 请求）

```
run(messages)
  ├─ Fast Path 检查：纯算术 → 直接返回 "Fast Path resolved: N"（无 LLM 调用）
  ├─ 技能注入：indexText() → unshift 一条 system 消息
  └─ 循环（最多 8 轮）：
      nextResponse(): 优先 chatStream（流式）
        ├─ content 增量 → emit agent/delta（前端打字机）
        ├─ reasoning 增量 → emit agent/reasoning（思考块）
        └─ tool_calls 增量 → 按 index 合并
      ├─ 有 toolCalls？
      │   ├─ 每个 call：emit agent/tool-call
      │   ├─ needsApproval？→ ctx.approval.request() 挂起（前端审批/超时拒绝）
      │   ├─ ctx.tools.call() → emit agent/tool-result
      │   └─ 结果 push 回 messages
      ├─ emit agent/step（每轮快照）
      └─ 无 toolCalls → emit agent/done(answer) → 返回
```

### 5. HTTP 桥（web-server，src/plugins/web-server.ts）

Node 内置 `http`，零额外依赖。端点：

| 端点 | 用途 |
|------|------|
| `GET /api/tools` | 工具清单（含 needsApproval 标注） |
| `GET /api/models` | 模型列表（网关不支持 /v1/models 时 fallback 默认模型） |
| `GET /api/skills` | 技能索引 |
| `POST /api/chat` | SSE 流：`step / tool-call / tool-result / approval-request / delta / reasoning / done / error` |
| `POST /api/approval` | `{callId, decision}` → resolve 审批 |
| `GET/POST /api/sessions`、`GET/DELETE /api/sessions/:id` | 会话持久化（JSON 落 `<cwd>/.data/sessions/`） |

SSE 用每请求短生命周期监听 + cleanup，并发请求不串流。

### 6. 前端（apps/web）

- `api.ts`：SSE 解析（`event:` / `data:` 帧）+ REST 封装
- `App.tsx`：消息状态机（delta 累积 / step 去重 / toolCalls 状态 / 审批决策 / 会话自动保存 debounce）
- `MessageList.tsx`：thinking 块（折叠）→ 工具卡 → 总结，顺序渲染
- `ToolCallCard.tsx`：工具卡 + 审批按钮（awaitingApproval 态）

## 面试导读（怎么讲这个项目）

### 总览一句话
「我实现了一个模仿 deepseek-harness 的插件化 Agent 运行时：LLM 后端、工具、审批、技能、前端全是 Cordis 插件，一份配置组合驱动，支持流式输出和人机协同审批。」

### 每个模块的「为什么这么设计」

| 模块 | 讲什么 | 常见追问 |
|------|--------|---------|
| Agent 循环 | Fast Path 短路（能算的不问模型）、流式优先（chatStream 统一，chat 兜底）、tool_calls 按 index 增量合并 | 为什么最多 8 轮？→ 防死循环 |
| 审批流 | Promise 挂起 + 超时自动拒绝（循环永不 hang）；拒绝结果喂回模型（模型可调整）而非中断 | 审批怎么跨请求？→ 全局 callId 注册表 |
| 流式 | delta 事件逐 token；step 事件在流式下跳过 append（防重复）；reasoning_content 单独通道 | 为什么要有 reasoning？→ DeepSeek 系模型思考过程 |
| 插件化 | definePlugin 解决 tsx 把 class name 设为只读的坑；包名加载跨生态 | inject 是什么？→ Cordis 依赖声明 |
| 工具 | `error:` 前缀约定让循环容错；读/写/跑 三档权限（只读无审批，写/跑审批） | 为什么 shell 必须审批？ |
| 技能 | 索引注入 system prompt + 模型用 read-file 读 SKILL.md；scripts/ 由 shell 执行 | 技能和工具的区别？ |

### 你踩过的坑（面试弹药）
- pnpm workspace：根命令行用的工具必须声明在根；子包 @types 必须自己声明
- @types/node 22：`readFile`/`Dirent` 返回 `string | NonSharedBuffer` union
- Cordis：函数插件 dispose 用返回 disposer，不能 `ctx.on('dispose')`
- tsx/esbuild：class/function 的 `name` 只读 → definePlugin 用 `Object.defineProperty` 改写

## 扩展指南

| 想做什么 | 怎么做 |
|---------|--------|
| 加工具 | `make new-plugin name=x` 或用现成模板写 `tool-x.ts` + registry + yml |
| 加技能 | `skills/<name>/SKILL.md`（frontmatter: name/description + 步骤），重启即索引 |
| 换模型 | 写 LLM 适配器实现 `LlmService`（chat + 可选 chatStream），挂进 yml |
| 加服务 | `src/services/` 新 Service + `declare module 'cordis'` + registry + 需要处 inject |
| 接 MCP | 已在 `cordis*.yml` 的 `mcp` 条目配 `servers:`（stdio/http），详见 README 示例 |
