# resolve-studio

English | [中文](README.zh.md)

一个用 **TypeScript** 写的 Agent 运行时，模仿 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的「**everything is a plugin**」设计，底层使用 [Cordis](https://cordis.xiaoyaoji.cn/) 的依赖注入容器。

核心思想：LLM 后端、工具、Agent 循环、审批、技能、前端（CLI/Web）全部是 Cordis **插件/服务**，由一份 `cordis*.yml` 组合驱动。换模型、加工具、换前端都只是改配置，不动核心代码。

> 架构细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)（含每个模块的面试导读）；示例问题见 [docs/demo-prompts.md](docs/demo-prompts.md)。

## 特性一览

| 能力              | 说明                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------- |
| **Agent 循环**    | LLM ⇄ 工具多轮循环（普通 8 轮 / PSE 模式 15 轮），流式输出，事件驱动                   |
| **PSE 三角色**    | Planner-Specialist-Evaluator 工作流，UI 一键开关，角色定义从 souls 目录加载             |
| **OS 级沙箱**     | shell 命令在 macOS Seatbelt / Linux bwrap 沙箱中执行，可写目录受限                     |
| **沙箱工作区**    | write-file 默认写入 `sandbox/<task>/`，任务级目录隔离，路径自动规范化                  |
| **Fast Path**     | 纯算术等确定性输入**零模型调用**秒回（`3+4` → `7`）                                    |
| **工具审批**      | `needsApproval` 工具执行前挂起，UI 上 Approve/Reject，超时自动拒绝（60s）              |
| **流式输出**      | SSE `delta` 逐 token 打字机；DeepSeek 系 `reasoning_content` 思考过程单独显示          |
| **联网探索**      | Playwright 驱动系统 Chrome（零下载）：`browser-open`（提取正文）/ `browser-screenshot` |
| **技能 Skills**   | 外部 `resolve-skills/skills/<name>/SKILL.md` 指令包，索引注入 system prompt             |
| **会话持久化**    | 会话历史（含工具卡与思考块）JSON 落盘，刷新恢复                                        |
| **Markdown 渲染** | 表格/代码块/列表（react-markdown + remark-gfm）                                        |
| **插件脚手架**    | `make new-plugin name=x` 一键生成插件包并接线                                          |
| **跨生态加载**    | 支持按 npm 包名动态加载纯 Cordis 插件（dsh `cordis.patch.yml` 格式）                   |
| **MCP 接入**      | 连接任意 MCP Server（stdio/http），工具以 `<id>:<tool>` 注册，默认需审批               |
| **专用工具集**    | 文章写作/发布、简历定制、面试题生成、CRM 任务、投资组合汇总、项目发现等 60+ 工具        |

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

## 环境变量配置

复制 `.env.example` 为 `.env` 并按需填写：

| 变量                            | 说明                                    | 默认值                     |
| ------------------------------- | --------------------------------------- | -------------------------- |
| `OPENAI_BASE_URL`               | OpenAI 兼容 API 地址                    | —                          |
| `OPENAI_API_KEY`                | API Key                                 | —                          |
| `OPENAI_MODEL`                  | 默认模型                                | —                          |
| `WORKSPACE_OUT`                 | 工作区扫描报告输出目录                  | `<cwd>/workspace-analysis` |
| `SERENA_UV`                     | `uv` 二进制路径（运行 serena 代码分析） | `uv`（PATH 查找）          |
| `HARNESS_EXTRA_ROOTS`           | 额外允许的文件系统根目录（逗号分隔）    | —                          |
| `HARNESS_SHELL_ALLOW_TRAVERSAL` | 设为 `1` 允许 shell 工具目录跳转        | `0`                        |
| `HARNESS_PRICES`                | 自定义模型价格表（JSON）                | 内置价格表                 |
| `SANDBOX_ENABLED`               | 开启 OS 级沙箱（macOS Seatbelt/Linux bwrap） | `false`               |
| `SANDBOX_ALLOW_NETWORK`         | 沙箱中允许网络访问                      | `true`                     |
| `PSE_ENABLED`                   | 开启 PSE 三角色模式                     | `false`                    |
| `PSE_SOULS_DIR`                 | PSE 角色定义目录                        | `HARNESS_SKILLS_DIR/../souls` |
| `CREWAI_PSE_DIR`                | crewai-pse 项目路径                     | 相对路径自动推导           |
| `AUTOGEN_PSE_DIR`               | autogen-pse 项目路径                    | 相对路径自动推导           |
| `LLAMAINDEX_PSE_DIR`            | llamaindex-pse 项目路径                 | 相对路径自动推导           |
| `LANGGRAPH_PSE_DIR`             | langgraph-pse 项目路径                  | 相对路径自动推导           |

> 所有路径类配置都支持环境变量覆盖，无需修改代码即可在不同机器间迁移。

## 配置驱动组合

四个配置 = CLI/Web × mock/真实模型：

| 配置                    | LLM         | 前端     |
| ----------------------- | ----------- | -------- |
| `cordis.yml`            | mock        | CLI REPL |
| `cordis.web.yml`        | mock        | Web UI   |
| `cordis.openai.yml`     | OpenAI 兼容 | CLI REPL |
| `cordis.openai.web.yml` | OpenAI 兼容 | Web UI   |

`loader.ts` 解析 `plugins` 列表，把 `name` 映射到 `src/plugins/registry.ts` 的本地插件（短名）或动态 `import()`（npm 包名）。`cordis.patch.yml` 沿用 dsh 的 `- insert:` 清单格式，按包名加载 `@cordisjs/plugin-timer`、`@resolve-studio/plugin-hello` 等。

## 运行时服务（ctx.*）

| 服务             | 职责                                                                   |
| ---------------- | ---------------------------------------------------------------------- |
| `ctx.llm`        | 聊天补全契约，`chat` + `chatStream`（流式，默认 fallback）             |
| `ctx.tools`      | 工具注册表（register/list/schemas/call），异常转 `error:` 前缀不崩循环 |
| `ctx.agent`      | Agent 循环：Fast Path → 技能注入 → LLM ⇄ 工具（含审批挂起）            |
| `ctx.approval`   | 人机审批：挂起等待 / 外部 resolve / 超时自动拒绝                       |
| `ctx.fastpath`   | 确定性预处理器（纯算术短路）                                           |
| `ctx.skills`     | 技能索引（扫描外部 `resolve-skills/skills/*/SKILL.md`，frontmatter 解析） |
| `ctx.pse`        | PSE 三角色模式：开关状态、角色定义加载、系统提示词注入                 |
| `ctx.sandbox`    | OS 级沙箱：Seatbelt/bwrap profile 生成、shell 命令包装                 |
| `ctx.mcp`        | MCP 客户端：连接/断开 server，工具动态注册                             |
| `ctx.systemInfo` | 运行时诊断（内存/CPU/uptime/平台，定时采集 + 事件发射）                |

## 安全与沙箱

resolve-studio 提供多层安全机制，防止 LLM 误操作破坏系统：

| 层级 | 机制 | 说明 |
|------|------|------|
| **OS 级沙箱** | macOS Seatbelt / Linux bwrap | shell 命令只能写入工作目录 + 系统临时目录，无法访问其他位置 |
| **路径守卫** | fs-roots 服务 | write-file 受白名单目录限制，越界路径直接拒绝 |
| **沙箱工作区** | `sandbox/<task>/` | write-file 相对路径自动写入任务隔离目录，路径自动去重 |
| **人工审批** | approval 服务 | shell 等高危工具执行前需人工确认，60s 超时自动拒绝 |
| **MCP 隔离** | fs MCP 限制 | fs MCP server 只暴露 sandbox 目录，不暴露整个文件系统 |

开启沙箱：`.env` 中设置 `SANDBOX_ENABLED=true`。

## PSE 三角色模式

Planner-Specialist-Evaluator 工作流，让 LLM 按角色分工完成复杂任务：

- **Planner**：规划分解任务，不亲自写代码
- **Specialist**：执行具体子任务
- **Evaluator**：独立验收，输出 PASS/PARTIAL/FAIL/BLOCKED

UI 顶部一键开关，或 `.env` 中设置 `PSE_ENABLED=true`。PSE 模式下 Agent 循环上限自动提升到 15 轮。

## 内置工具（60+，⚠ = 需审批）

基础工具：
```
hello · echo · calculator⚠ · read-file · write-file · shell⚠
browser-open · browser-screenshot · pick-post · system-info · skill-run
```

专用工具（文章/投资/面试/CRM）：
```
article-write · article-validate · article-publish · article-archive · article-discover
resume-tailor · interview-questions · crm-task · portfolio-summary · pse-review
wp-publish · crewai-publish · crewai-discover
```

读的操作无审批（browser/pick-post/read-file/system-info），写与执行必过审批（shell/calculator 演示）。**MCP server 的工具**（配置 `servers:` 后）以 `<serverId>:<toolName>` 追加注册，默认同样需审批。

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
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/allowed/dir']
      - id: remote
        transport: http
        url: https://example.com/mcp
        approval: false # 只读 server 可关审批
```

连接后工具列表会出现 `fs:read_file`、`fs:list_directory` 等，模型可直接调用。

## 脚本

包管理器固定 **pnpm**，常用任务收敛到 `Makefile`（`make help`）：

| 命令                                  | 作用                                      |
| ------------------------------------- | ----------------------------------------- |
| `make install`                        | 装全部依赖                                |
| `make check`                          | typecheck + test（**57 个用例**）         |
| `make lint` / `make lint-fix`         | ESLint 检查 / 自动修复                    |
| `make format` / `make format-check`   | Prettier 格式化 / 格式检查                |
| `make build` / `make build-web`       | 构建后端 / 前端                           |
| `make dev` / `make dev-mock`          | 单终端起后端+前端（真实模型 / 离线 mock） |
| `make chat` / `make chat-real`        | 起 CLI                                    |
| `make new-plugin name=x`              | 脚手架生成新插件包                        |
| `make docker-up` / `make docker-down` | Docker Compose 起/停（后端+nginx 前端）   |
| `make clean`                          | 清构建产物                                |

## Web UI（React + Vite，apps/web/）

后端 `web-server` 插件（零依赖，Node 内置 `http`）把 `agent/*` 事件以 **SSE** 推给前端：

- `GET /health` → 健康检查（uptime / 内存 / 工具数 / MCP server 数）
- `POST /api/chat` → SSE：`step / tool-call / tool-result / approval-request / delta / reasoning / usage / done / error`
- `GET /api/tools` · `GET /api/models` · `GET /api/skills`
- `POST /api/approval`（`{callId, decision}`）
- `GET/POST /api/sessions` · `GET/DELETE /api/sessions/:id`（持久化）
- `GET /api/usage?sessionId=<id>` → 全局或按会话的 token/费用统计

前端结构：`api.ts`（SSE 客户端）· `App.tsx`（布局 + 组合）· `hooks/useChat.ts`（消息状态机 + 流式 + 审批）· `hooks/useSessions.ts`（会话 CRUD + 自动保存）· `hooks/useMcp.ts`（MCP server 管理）· `MessageList.tsx`（thinking→工具卡→总结）· `ToolCallCard.tsx`（工具卡 + 审批按钮）· `Composer.tsx` · `ErrorBoundary.tsx`（根级错误兜底）。

## 扩展

详见 [docs/plugin-authoring.md](docs/plugin-authoring.md)（从骨架到完整插件的逐步指南）。

- **加工具**：`make new-plugin name=x` 生成包，或在 `src/plugins/` 写 `tool-x.ts` + registry + yml
- **加技能**：在外部 `resolve-skills/skills/<name>/SKILL.md`（frontmatter: name/description + 步骤），通过 `HARNESS_SKILLS_DIR` 环境变量指定目录，重启即入索引
- **加 LLM 后端**：继承 `LlmService` 实现 `chat`（+ 可选 `chatStream`）
- **加服务**：`src/services/` 新 Service + `declare module 'cordis'` + 需要处 `inject`
- **外部插件**：遵循纯 Cordis 契约（只 import `cordis`），按包名发布到 npm，`cordis.yml` 里直接引用

## 实现笔记

- Cordis 4 的 `Context` 用 `declare module './context'` 注入；tsconfig 必须 `module: ESNext` + `moduleResolution: Bundler`。
- **跨服务访问必须声明 `inject`**：否则 Cordis 属性拦截器抛 `cannot get property "xxx" without inject`。函数插件用 `definePlugin(fn, name, ['tools'])`，Service 用 `static inject`。
- 插件函数返回 **disposer** 做清理（关浏览器/关 server）——不能 `ctx.on('dispose')`（不在事件类型里）。
- `definePlugin` 用 `Object.defineProperty` 把 `name` 设为可写，绕开 tsx/esbuild 对 class/function `name` 的只读限制。
- SSE 用每请求独立的短时监听器（`ctx.events.on` 返回 disposer），请求结束回收，并发会话不串台。
- pnpm workspace 注意：根命令行用的工具（tsx 等）必须声明在根；子包 tsconfig 引用的 `@types/*` 必须在自己 devDeps 声明。

## 工程化

- **ESLint**（flat config）+ **Prettier**：`pnpm run lint` / `pnpm run format`，配置在根目录 `eslint.config.js` / `.prettierrc.json`
- **EditorConfig**：统一缩进/换行/编码
- **CI**（GitHub Actions）：`.github/workflows/ci.yml`，push/PR 自动跑 typecheck + test + build + lint + format-check
- **Docker**：多阶段构建后端镜像，`docker-compose.yml` 起后端 + nginx 前端（`/api` 反代到后端，SSE 支持）

```bash
# 本地一键起容器
make docker-up        # 后端 :8787 + 前端 :5173
make docker-down
```
