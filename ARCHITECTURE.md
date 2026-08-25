# agent-harness 架构文档

> 一份关于 `agent-harness` 运行时设计与实现的说明，对应源码 `src/`。
> 配套图示见 `README.md` 的「架构」小节与对话中的架构图。

---

## 1. 设计哲学：everything is a plugin

`agent-harness` 是一个用 **TypeScript** 写的 Agent 运行时，模仿 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的「**一切皆插件**」设计，底层使用 [Cordis](https://cordis.xiaoyaoji.cn/) 的依赖注入（DI）容器。

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

`PLUGINS` 是一张 `name → Cordis Plugin` 的字典，目前收录：

| name | 类型 | 真实实现 |
| --- | --- | --- |
| `tools` | 服务 | `ToolRegistry` |
| `agent` | 服务 | `AgentService` |
| `llm-mock` | 适配器插件 | `llmMock` |
| `llm-openai` | 适配器插件 | `llmOpenAi` |
| `tool-echo` | 工具插件 | `toolEcho` |
| `tool-calculator` | 工具插件 | `toolCalculator` |
| `cli-chat` | 前端插件 | `cliChat` |
| `web-server` | 前端插件 | `webServer` |

### 2.4 插件元数据 `src/plugins/util.ts`

`definePlugin(target, name, inject?)` 是统一的插件包装器，解决两个 Cordis 4 的坑：

1. **`name` 只读**：tsx/esbuild 的 `__name` helper 把 class/function 的 `name` 标成只读，Cordis 用 `Object.assign(plugin, { name })` 注入元数据时会在运行时抛 `Cannot assign to read only property 'name'`。`definePlugin` 用 `Object.defineProperty(..., { writable: true })` 把 `name` 设成可写再赋值。
2. **`inject` 形状**：Cordis 4 内部把 `inject` 存成对象（`{ agent: {} }`），直接传 `string[]` 会让 `Object.entries` 把数组下标当服务名，导致 `ctx.<service>` 访问报错。`normalizeInject` 把数组也规范化为对象形式，兼容两种写法。

---

## 3. 三大核心服务

三个 Cordis 服务都挂在根 `ctx` 上，通过 `declare module 'cordis'` 注入类型，互相之间通过 `inject` 声明依赖。

```
            ┌─────────────────── Cordis Context (ctx) ───────────────────┐
            │                                                            │
   ctx.llm  │  ctx.tools            ctx.agent                           │
   LlmService│  ToolRegistry         AgentService                       │
   (chat/    │  (register/list/      (驱动 LLM⇄tools 循环)              │
    models)  │   schemas/call)                                        │
            │        ▲                    │ uses                         │
            │        │ registers          ▼                             │
            └────────┴────────────────────┘
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

| 方法 | 作用 |
| --- | --- |
| `register(tool)` | 注册 / 覆盖一个工具 |
| `unregister(name)` | 移除 |
| `list()` | 返回全部 `Tool` |
| `schemas()` | 转为喂给 LLM 的 `ToolSchema[]` |
| `get(name)` | 按名查找 |
| `call(name, args)` | 调用工具 |

`call` 是容错核心：`args` 既可以是模型返回的 JSON 字符串，也可以是已解析对象；解析失败或执行抛错都会返回 `error: ...` 字符串而非抛异常，让 Agent 循环能继续（而不是整个进程崩）。每次调用都会发射 `tools/call` 事件。

### 3.3 `ctx.agent` — `src/services/agent.ts`

`AgentService` 实现经典 **LLM ⇄ tools 循环**。关键实现要点：

```ts
static inject = { tools: {}, llm: {} }   // 声明跨服务依赖
```

> **隐藏 bug 修复记录**：`AgentService` 必须声明 `inject`，否则 `run()` 内部访问 `this.ctx.tools` / `this.ctx.llm` 时，Cordis 的属性拦截器会抛 `cannot get property "xxx" without inject`。这是 Cordis 4 的强制约束——任何跨服务访问都要先登记。

`run(options)` 的逻辑：

1. **Fast Path 前置**（见 §3.1）：取最后一条 `role: 'user'`、`content` 为字符串的消息，交由 `ctx.fastpath.tryResolve` 做确定性解析。命中（`3+4` → `7`）则直接发射 `agent/done` 返回，**整个 LLM 循环被短路、零模型调用**。
2. 取 `tools`（默认 `ctx.tools.schemas()`）和 `maxIterations`（默认 8）。
3. 复制一份 `messages`，**不修改调用方的数组**。
4. 循环：
   - 调 `ctx.llm.chat(messages, { tools, model })` 拿下一步。
   - 有 `toolCalls` 时逐个 `ctx.tools.call`，把 `role: 'tool'` 结果塞回 `messages`，并发射 `agent/tool-call` / `agent/tool-result`。
   - 每轮发射 `agent/step`（含 assistant 消息、toolCalls、toolResults）。
   - 无 `toolCalls` 时发射 `agent/done` 并返回最终答案。
5. 超过 `maxIterations` 仍无终答，发射 `agent/done` 返回兜底文案。

### 3.4 Fast Path 服务（`ctx.fastpath`）

移植自 resolve-harness 的「能算的绝不让模型算」原则，但做了 TS 化精简：

- **独立 Cordis 服务**，含一个纯函数 `tryResolve(text): string | null`。
- 仅识别**纯算术字符**（`[0-9+\-*/().\s]`），用内置 shunting-yard 求值器（与 calculator 工具同源思路，但零耦合）。
- 命中返回结果字符串；非纯算术或求值失败返回 `null`，交回 LLM 循环。
- 这是一道**防线**而非工具替代品——`calculator` 工具仍在，模型仍可在自己的判断下调用它。

### 3.5 工具审批标志（`needsApproval`）

`Tool` / `ToolSchema` 增加可选字段 `needsApproval`（默认 `false`）。当前语义：

- 后端 `ToolRegistry.schemas()` 透传该标志；
- 前端在工具列表与工具调用卡片上以 `⚠` + 边框标注「需审批」的工具（如 `calculator`）；
- 为后续 human-in-the-loop 审批流预留接口，当前不阻断执行。

---

## 4. 事件总线

Cordis 的 `ctx.events` 是连接「循环内部」与「前端观察者」的**解耦层**。所有事件类型在 `declare module 'cordis' { interface Events }` 里声明：

| 事件 | 载荷 | 发射方 |
| --- | --- | --- |
| `agent/step` | `AgentStep` | `AgentService` |
| `agent/tool-call` | `ToolCall` | `AgentService` |
| `agent/tool-result` | `{ call, result, ok }` | `AgentService` |
| `agent/done` | `string`（最终答案） | `AgentService` |
| `tools/call` | `{ name, args, ok, result }` | `ToolRegistry` |

设计意图：**前端不需要知道循环内部细节**，只要监听这些事件就能流式渲染进度。CLI、Web、测试都是同一套事件的消费者。

---

## 5. 两种前端（互斥）

前端都是「挂在 `ctx` 上的插件」，与 `cli-chat` / `web-server` 平级。二者**互斥**——不能同时挂，否则 REPL 会抢 stdin。

### 5.1 `cli-chat` — `src/plugins/cli-chat.ts`

最小的「前端」：`readline` 监听 stdin，每行喂给 `ctx.agent.run`，监听 `agent/tool-call` / `agent/tool-result` 打印进度，监听 `/exit` 退出。维护一个 `history` 数组实现多轮对话。

### 5.2 `web-server` — `src/plugins/web-server.ts`

基于 Node 内置 `http`（零额外依赖）的 HTTP 桥：

| 端点 | 方法 | 作用 |
| --- | --- | --- |
| `/api/tools` | GET | 返回 `ctx.tools.schemas()` |
| `/api/models` | GET | 返回 `ctx.llm.models()` |
| `/api/chat` | POST | `{ messages, model }` → SSE 流 |

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

- `web/src/api.ts`：SSE 客户端，用 `fetch` + `ReadableStream` 逐帧解析 `event:` / `data:`。
- `web/src/App.tsx`：对话状态机，把 `step` / `tool-call` / `tool-result` / `done` 事件归并成 `UIMessage`。
- `web/src/ToolCallCard.tsx`：工具调用卡片（名称、入参、结果、成功/失败）。
- `web/src/Composer.tsx`：输入框。
- `vite.config.ts`：`server.host = '127.0.0.1'`（避免默认绑 `::1` 导致 `127.0.0.1` 访问空），`proxy` 把 `/api` 反代到后端 `:8787`。

> 生产构建（`make build-web` → `web/dist/`）是纯静态文件，托管到任意地方只需把 `/api` 反代到后端 `:8787`。

---

## 7. 配置组合矩阵

三个 `cordis.yml` 变体决定「挂哪个 LLM + 哪个前端」：

| 配置文件 | LLM | 前端 | 用途 |
| --- | --- | --- | --- |
| `cordis.yml`（默认） | `llm-mock` | `cli-chat` | 离线 REPL demo |
| `cordis.web.yml` | `llm-mock` | `web-server` | 离线 Web demo |
| `cordis.openai.yml` | `llm-openai` | `cli-chat` | 真实模型 REPL |
| `cordis.openai.web.yml` | `llm-openai` | `web-server` | 真实模型 Web |

示例（默认）：

```yaml
plugins:
  - { name: tools }
  - { name: agent }
  - { name: llm-mock, config: { tool: echo } }
  - { name: tool-echo }
  - { name: tool-calculator }
  - { name: cli-chat }
```

---

## 8. 实现要点与坑

1. **Cordis 4 的 `inject` 必须声明跨服务访问**（`AgentService.static inject = { tools:{}, llm:{} }`、函数插件第三个参数 `['tools']`）。漏了就抛 `cannot get property "xxx" without inject`。
2. **tsconfig 必须用 `module: ESNext` + `moduleResolution: Bundler`**：改用 `NodeNext` 时 Cordis 的 `exports` 未暴露 `./context` 子路径，TS 无法解析 `Context` 的 class 实现，报 `'Context' only refers to a type`。
3. **关闭 `declaration`**：Cordis `Service` 用了私有 symbol 属性，匿名 class 导出 `.d.ts` 会报 `cannot be named`。运行期用 tsx 直接跑 `.ts`，无需声明文件。
4. **API 调用走属性式**（`ctx.registry.plugin` / `ctx.events.on/emit`），不依赖方法式 augmentation。
5. **SSE 用「每请求独立短时监听器」**，请求结束 `finally` 回收，避免并发会话串台。
6. **包管理器固定 pnpm**；pnpm 9 lockfile 是 registry-agnostic 的（只记 integrity 哈希 + 包名版本，无 tarball host 写死），镜像切换无需 sed 改 lockfile。
7. **Vite 默认绑 `::1`**，本地 `127.0.0.1:5173` 访问会空——必须在 `vite.config.ts` 显式设 `server.host = '127.0.0.1'`。

---

## 9. 扩展指南

- **加工具**：`src/plugins/` 里写 `definePlugin((ctx) => ctx.tools.register({...}), 'tool-xxx', ['tools'])`，并在 `registry.ts` 的 `PLUGINS` 与对应 `cordis.yml` 登记。
- **加 LLM 后端**：继承 `LlmService`，实现 `chat()` / `models()`，用 `definePlugin` 注册，再在 `cordis.yml` 替换 `llm-*` 条目。
- **换前端**：写一个新的「监听 `agent/step` 等事件」的插件即可（如 Web / A2A 前端），与 `cli-chat` 平级、互斥挂载。

---

## 10. 一键运行

包管理器固定 **pnpm**，常用任务收敛在 `Makefile`（`make help` 查看）：

| 命令 | 作用 |
| --- | --- |
| `make install` | 装后端 + 前端依赖 |
| `make check` | `typecheck`(src) + `test` |
| `make build` | 编译后端到 `dist/` |
| `make build-web` | 构建前端到 `web/dist/` |
| `make dev` | 单终端起后端（mock）+ 前端 dev，开 `:5173` 即可聊，`Ctrl-C` 退出 |
| `make dev-real` | 同上，但后端接真实模型（`cordis.openai.web.yml`） |
| `make chat` / `make chat-real` | 起 CLI（mock / 真实模型） |
| `make clean` | 清构建产物 |
