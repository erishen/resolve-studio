# 接入常用 MCP Server 指南

本指南说明如何给 resolve-studio 接入 Model Context Protocol（MCP）服务器，
把外部能力（文件系统、GitHub、数据库、浏览器、搜索等）以「工具」的形式暴露给 Agent。

> 适用版本：当前 `packages/core` 的 `McpService`。所有 MCP 工具的调用默认需要人工审批（approval 门控），失败不会拖垮整个运行时。

---

## 一、两种接入方式

### 方式 A：UI 实时添加（推荐，可持久化）

1. 启动应用：`make dev`（真实模型）或 `make dev-mock`（离线）。
2. 打开 `http://127.0.0.1:5173`，右侧 **RUNTIME** 面板展开 **MCP Servers**。
3. 点「添加」，填写表单：
   - **id**：唯一标识，只能用 `[a-zA-Z0-9_-]`（如 `fs`、`github`）。它会成为工具名前缀 `<id>:<tool>`。
   - **transport**：`stdio`（本地进程）或 `http`（远程 Streamable HTTP）。
   - **command / args**（stdio 用）：启动命令与参数。
   - **url**（http 用）：远程 MCP 端点。
   - **approval**：是否每次调用需人工审批。默认开（true）；纯只读服务器可关（false）。
4. 提交后写入 `<cwd>/.data/mcp-servers.json`，**重启应用会自动重连，配置保留**。

### 方式 B：直接改 JSON / yml（适合批量或离线）

- **运行时持久化文件**（重启自动加载）：
  `<cwd>/.data/mcp-servers.json`，格式为配置数组，见下文示例。
- **静态写死在组合里**（随 `cordis*.yml` 加载，适合团队共享）：
  在 `cordis.openai.web.yml` 的 `plugins` 里加一项 `id: mcp` 的 `servers` 列表。

> 注意：`.data/` 已被 `.gitignore` 忽略，运行时的 MCP 配置**不会进 git**。
> 若要让全团队都用同一套，请走 yml 静态配置，而不是 `.data` 文件。

---

## 二、配置字段

| 字段        | 必填       | 说明                                                                       |
| ----------- | ---------- | -------------------------------------------------------------------------- |
| `id`        | 是         | 唯一标识，正则 `[a-zA-Z0-9_-]`；作为工具名前缀                             |
| `transport` | 是         | `stdio` 或 `http`（UI/POST 不填默认 `stdio`）                              |
| `command`   | stdio 必填 | 启动命令，如 `npx`                                                         |
| `args`      | 否         | 命令参数数组，如 `["-y","@modelcontextprotocol/server-filesystem","/tmp"]` |
| `env`       | 否         | 额外环境变量，如 `{"GITHUB_TOKEN":"ghp_xxx"}`                              |
| `url`       | http 必填  | 远程端点，如 `https://example.com/mcp`                                     |
| `approval`  | 否         | 默认 `true`（调用需审批）；只读服务器可设 `false`                          |

---

## 三、常用 MCP Server 示例

下面每个示例都是「可直接贴进 `.data/mcp-servers.json` 数组」的片段。
stdio 类多数用 `npx` 拉取官方 `@modelcontextprotocol/server-*` 包。

> 国内网络提示：用 `npx` 拉包依赖 `registry.npmjs.org`，可能遇 `ECONNRESET`。
> 可在本机先 `pnpm config set registry https://registry.npmmirror.com`，
> 或预先 `npm i -g @modelcontextprotocol/server-filesystem` 后把 `command` 指向全局可执行文件。

### 1. 文件系统（读/写本地目录）

```json
{
  "id": "fs",
  "transport": "stdio",
  "command": "npx",
  "args": [
    "-y",
    "@modelcontextprotocol/server-filesystem",
    "WORKSPACE"
  ],
  "approval": true
}
```

> ⚠️ **allowed directory 必须覆盖实际访问路径**：`@modelcontextprotocol/server-filesystem` 只允许访问启动参数里列出的根目录（可传多个，如 `"...filesystem", "/path/A", "/path/B"`）。若 Agent 要访问的路径不在其中，会报 `Access denied - path outside allowed directories`。上面示例用 invest 工作区根目录，已覆盖 `frameworks/`、`work/` 等子目录；只写 `Desktop` 这类单一目录是常见踩坑点。

> ⚠️ **`directory_tree` 对大仓库会撑爆上下文**：该 MCP 的 `directory_tree` / `list_directory` 会**无限制**返回整棵递归目录树，对含 `.venv` / `node_modules` 的大仓库（数万文件）会产出几十万 token，直接触发 `400 ... exceeds the model's maximum context length`。**分析大型目录请用 harness 自带的 `analyze_directory` 工具**——它的输出有硬上限（树行数 / 文件数 / 总字节都封顶），安全且更有用。

### 2. GitHub（issues/PR/仓库操作，需 token）

```json
{
  "id": "github",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": { "GITHUB_TOKEN": "ghp_你的token" },
  "approval": true
}
```

> token 也可放 `.env` 后用 `process.env` 注入；不要把明文 token 提交到 git。

### 3. Fetch（让 Agent 抓取网页）

```json
{
  "id": "fetch",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-fetch"],
  "approval": false
}
```

### 4. Git（仓库级 git 操作）

```json
{
  "id": "git",
  "transport": "stdio",
  "command": "npx",
  "args": [
    "-y",
    "@modelcontextprotocol/server-git",
    "--repository",
    "WORKSPACE"
  ],
  "approval": true
}
```

### 5. SQLite（查询本地数据库，只读可关审批）

```json
{
  "id": "sqlite",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-sqlite", "--db-path", "/path/to/app.db"],
  "approval": false
}
```

### 6. Playwright（浏览器自动化）

```json
{
  "id": "playwright",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@playwright/mcp@latest"],
  "approval": true
}
```

### 7. Brave Search（网页搜索，需 API key）

```json
{
  "id": "brave",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-brave-search"],
  "env": { "BRAVE_API_KEY": "你的key" },
  "approval": false
}
```

### 8. Memory（跨会话长期记忆，本地文件）

```json
{
  "id": "memory",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-memory"],
  "approval": false
}
```

### 9. Sequential Thinking（结构化推理，无外部依赖）

```json
{
  "id": "think",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-sequentialthinking"],
  "approval": false
}
```

### 10. 远程 HTTP（Streamable HTTP）示例

```json
{
  "id": "remote-demo",
  "transport": "http",
  "url": "https://example.com/mcp",
  "approval": true
}
```

---

## 四、审批（approval）怎么设

- 默认 `true`：每次调用都要你在 UI 点「批准」。适合**有副作用**的服务器（写文件、git push、GitHub 修改）。
- 只读服务器（fetch、sqlite 查询、brave 搜索、memory、think）可设 `false`，减少打扰。
- 即便设 `false`，**调用失败也只是记 error，不会让整个 harness 崩**。

---

## 五、排查与验证

1. 添加后在 UI 看状态：`connected` 表示成功，列出该 server 注册的工具名（`<id>:<tool>`）；`error` 会附带原因。
2. 命令行直接试拉包，确认网络/包名没问题：
   `npx -y @modelcontextprotocol/server-filesystem --help`
3. 看后端日志：`make dev` 的日志在 `.run/backend.log`，搜索 `mcp` 关键字。
4. 工具名前缀冲突：两个 server 用相同 `id` 会后者覆盖前者，务必保证 `id` 唯一。

---

## 六、已知坑（已修复）

- **重启清空配置（已修）**：旧版 `connect()` 在启动重连时会误删持久化配置，
  导致每次重启 MCP server「又没了」。已在 `mcp.ts` 用 `unregisterConnection`
  替代 `disconnect` 修复，并有回归测试 `packages/core/tests/mcp.test.ts` 锁死。
  重加一次配置并重启即可长期保留。
- `.data/` 不进 git：团队共享请走 yml 静态 `servers`，不要依赖本地 `.data` 文件。
- `id` 仅限 `[a-zA-Z0-9_-]`：带空格或中文会直接被 API 拒绝（400）。
