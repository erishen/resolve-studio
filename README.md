# agent-harness

一个用 **TypeScript** 写的 Agent 运行时，模仿 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的「**everything is a plugin**」设计，底层使用 [Cordis](https://cordis.xiaoyaoji.cn/) 的依赖注入容器。

核心思想：LLM 后端、工具、Agent 循环、审批、技能、前端（CLI/Web）全部是 Cordis **插件/服务**，由一份 `cordis*.yml` 组合驱动。换模型、加工具、换前端都只是改配置，不动核心代码。

> 架构细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)（含每个模块的面试导读）；示例问题见 [docs/demo-prompts.md](docs/demo-prompts.md)。

## 特性一览

| 能力 | 说明 |
|------|------|
| **Agent 循环** | LLM ⇄ 工具多轮循环（最多 8 轮），流式输出，事件驱动 |
| **Fast Path** | 纯算术等确定性输入**零模型调用**秒回（`3+4` → `7`） |
| **工具审批** | `needsApproval` 工具执行前挂起，UI 上 Approve/Reject，超时自动拒绝（60s） |
| **流式输出** | SSE `delta` 逐 token 打字机；DeepSeek 系 `reasoning_content` 思考过程单独显示 |
| **联网探索** | Playwright 驱动系统 Chrome（零下载）：`browser-open`（提取正文）/ `browser-screenshot` |
| **技能 Skills** | `skills/<name>/SKILL.md` 指令包，索引注入 system prompt，可带 `scripts/` 由 shell 执行 |
| **会话持久化** | 会话历史（含工具卡与思考块）JSON 落盘，刷新恢复 |
| **Markdown 渲染** | 表格/代码块/列表（react-markdown + remark-gfm） |
| **插件脚手架** | `make new-plugin name=x` 一键生成插件包并接线 |
| **跨生态加载** | 支持按 npm 包名动态加载纯 Cordis 插件（dsh `cordis.patch.yml` 格式） |
| **MCP 接入** | 连接任意 MCP Server（stdio/http），工具以 `<id>:<tool>` 注册，默认需审批 |

## 快速开始

```bash
pnpm install
make dev            # 单终端：后端(mock) + 前端 dev → 浏览器开 http://127.0.0.1:5173
make dev-real       # 同上，接真实模型（需 cp .env.example .env 填 OPENAI_*）
```

CLI 版（不用浏览器）：

```bash
pnpm run chat                # mock LLM，离线
pnpm run chat -- --config cordis.openai.yml   # 真实模型
```

## 配置驱动组合

四个配置 = CLI/Web × mock/真实模型：

| 配置 | LLM | 前端 |
|------|-----|------|
| `cordis.yml` | mock | CLI REPL |
| `cordis.web.yml` | mock | Web UI |
| `cordis.openai.yml` | OpenAI 兼容 | CLI REPL |
| `cordis.openai.web.yml` | OpenAI 兼容 | Web UI |

`loader.ts` 解析 `plugins` 列表，把 `name` 映射到 `src/plugins/registry.ts` 的本地插件（短名）或动态 `import()`（npm 包名）。`cordis.patch.yml` 沿用 dsh 的 `- insert:` 清单格式，按包名加载 `@cordisjs/plugin-timer`、`@agent-harness/plugin-hello` 等。

## 运行时服务（ctx.*）

| 服务 | 职责 |
|------|------|
| `ctx.llm` | 聊天补全契约，`chat` + `chatStream`（流式，默认 fallback） |
| `ctx.tools` | 工具注册表（register/list/schemas/call），异常转 `error:` 前缀不崩循环 |
| `ctx.agent` | Agent 循环：Fast Path → 技能注入 → LLM ⇄ 工具（含审批挂起） |
| `ctx.approval` | 人机审批：挂起等待 / 外部 resolve / 超时自动拒绝 |
| `ctx.fastpath` | 确定性预处理器（纯算术短路） |
| `ctx.skills` | 技能索引（扫描 `skills/*/SKILL.md`，frontmatter 解析） |

## 内置工具（9 个，⚠ = 需审批）

```
hello · echo · calculator⚠ · read-file · write-file⚠ · shell⚠
browser-open · browser-screenshot · pick-post
```

读的操作无审批（browser/pick-post/read-file），写与执行必过审批（write-file/shell/calculator 演示）。**MCP server 的工具**（配置 `servers:` 后）以 `<serverId>:<toolName>` 追加注册，默认同样需审批。

### 接一个 MCP server（示例）

```yaml
# cordis.web.yml 的 mcp 条目
- id: mcp
  name: mcp
  config:
    servers:
      - id: fs
        transport: stdio
        command: npx
        args: ['-y', '@modelcontextprotocol/server-filesystem', '~erishen']
      - id: remote
        transport: http
        url: https://example.com/mcp
        approval: false    # 只读 server 可关审批
```

连接后工具列表会出现 `fs:read_file`、`fs:list_directory` 等，模型可直接调用。

## 脚本

包管理器固定 **pnpm**，常用任务收敛到 `Makefile`（`make help`）：

| 命令 | 作用 |
| --- | --- |
| `make install` | 装全部依赖 |
| `make check` | typecheck + test（**21 个用例**） |
| `make build` / `make build-web` | 构建后端 / 前端 |
| `make dev` / `make dev-real` | 单终端起后端+前端 |
| `make chat` / `make chat-real` | 起 CLI |
| `make new-plugin name=x` | 脚手架生成新插件包 |
| `make clean` | 清构建产物 |

## Web UI（React + Vite，apps/web/）

后端 `web-server` 插件（零依赖，Node 内置 `http`）把 `agent/*` 事件以 **SSE** 推给前端：

- `POST /api/chat` → SSE：`step / tool-call / tool-result / approval-request / delta / reasoning / done / error`
- `GET /api/tools` · `GET /api/models` · `GET /api/skills`
- `POST /api/approval`（`{callId, decision}`）
- `GET/POST /api/sessions` · `GET/DELETE /api/sessions/:id`（持久化）

前端结构：`api.ts`（SSE 客户端）· `App.tsx`（消息状态机 + 会话）· `MessageList.tsx`（thinking→工具卡→总结）· `ToolCallCard.tsx`（工具卡 + 审批按钮）· `Composer.tsx`。

## 扩展

- **加工具**：`make new-plugin name=x` 生成包，或在 `src/plugins/` 写 `tool-x.ts` + registry + yml
- **加技能**：`skills/<name>/SKILL.md`（frontmatter: name/description + 步骤），重启即入索引
- **加 LLM 后端**：继承 `LlmService` 实现 `chat`（+ 可选 `chatStream`）
- **加服务**：`src/services/` 新 Service + `declare module 'cordis'` + 需要处 `inject`

## 实现笔记

- Cordis 4 的 `Context` 用 `declare module './context'` 注入；tsconfig 必须 `module: ESNext` + `moduleResolution: Bundler`。
- **跨服务访问必须声明 `inject`**：否则 Cordis 属性拦截器抛 `cannot get property "xxx" without inject`。函数插件用 `definePlugin(fn, name, ['tools'])`，Service 用 `static inject`。
- 插件函数返回 **disposer** 做清理（关浏览器/关 server）——不能 `ctx.on('dispose')`（不在事件类型里）。
- `definePlugin` 用 `Object.defineProperty` 把 `name` 设为可写，绕开 tsx/esbuild 对 class/function `name` 的只读限制。
- SSE 用每请求独立的短时监听器（`ctx.events.on` 返回 disposer），请求结束回收，并发会话不串台。
- pnpm workspace 注意：根命令行用的工具（tsx 等）必须声明在根；子包 tsconfig 引用的 `@types/*` 必须在自己 devDeps 声明。
