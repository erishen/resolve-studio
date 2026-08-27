# TODO — resolve-studio 后续路线

> 状态标注：`[ ]` 待办 · `[x]` 已完成 · `[?]` 待用户决策

## 近期（先收尾）

- [x] **本地提交**：已 `git init` + 根提交 `4caaeea`（104 文件）+ 清理 commit `1774cbd`（清临时脚本），local only 未推送
- [ ] **是否推送 remote**：当前仅本地、无 remote；待用户决策是否建 remote 并 push
- [ ] **重启后端让改动生效**：MCP 配置（`fs` 追加 invest 根 / serena `--context claude-code`）· `mcp.ts` 120s 连接超时 · 新工具 `analyze-code-dir` · 引擎徽章后端字段 `engine`/`usedTools` · 用量徽章依赖 `usage` 服务——均需**重启 `make dev` 后端进程**才生效（前端 HMR 不生效，旧进程仍跑旧代码）
- [ ] `.env.example` 补齐：`PROD_WORDPRESS_USERNAME / PROD_WORDPRESS_APP_PASSWORD`（post-comment 复用）等新变量说明

## 第二层方向（差异化，二选一）

- [x] **MCP 接入**：plugins/mcp.ts，stdio/http 连接 MCP server，工具以 `<id>:<tool>` 注册进 ctx.tools（默认需审批可配置关）；测试 3 个（注册/关审批/失败降级）
- [x] **垂直投资 Agent（本地私有版）**：`portfolio-summary` 工具（桥接 autogen-pse prepare.py，只读无审批）+ `weekly-investment-review` 技能（真实持仓 → 周报）。真实数据仅限本地私有，不进简历/开源；如做公开演示需 sample_data + 匿名数据

## 体验与健壮性（第三层）

- [x] **长对话上下文管理**：`context.ts` `fitContext()` 滑动窗口截断 + 越预算插「早期消息已省略」提示
- [x] **流式中断**：`handleChat` 每请求 `AbortController`，`req` 关闭即 abort；前端 Stop 按钮
- [x] **多会话并发**：引入 `RunEventBus`，agent/usage/approval 事件按 run 隔离；Web 每请求传自己的 bus，两个并发 `/api/chat`（多 tab）SSE 互不串流（新增 `concurrency.test.ts` 锁定）
- [x] **成本/token 统计**：`usage.ts` + `/api/usage` + 前端 `.usage-badge`（¥ 估算）
- [x] **截图进 UI**：`browser-screenshot` 返回路径 → `/api/screenshots/<file>` 出图，前端 `<img class="tool-screenshot">`
- [x] **baseDir 限制**：`fs-guard.ts` `resolveSafe()`，write-file/shell 越界拒绝
- [x] **skill-run 工具**：`tool-skill-run.ts` 显式触发技能，已注册进 registry + 四个 yml
- [x] **pick-post 单元测试**：`pick-post.test.ts` 注入 mock，无网络依赖

## 站点侧（erishen.cn，与 harness 无关）

- [ ] **正文互链脚本**：扫现有文章，输出 PSE 系列该互相引用的「延伸阅读」清单（站内互链的正确姿势）
- [ ] **掘金/思否评论草稿技能**（tech-comment-draft）：读对方文章 → 生成真诚评论草稿（带自然链接）→ **只出草稿、人工提交**；知乎外链环境差暂不做
- [ ] **公众号 API 技能**（wechat-draft）：存草稿/发素材，需 appid+appsecret（待确认是否有开发者权限）

## 已知技术债（待排期）

- [x] **4 份 yml 重复条目漂移** → `scripts/gen-manifests.mjs` 单源生成 4 份 manifest（2×2 矩阵：mock/openai × 无 web/有 web + openai.web 的 `fs` 块与 pse-review config）；`make manifests` 重新生成；`tests/manifests.test.ts` 锁生成结果、漂移即失败
- [x] **审批粒度仅服务器级布尔** → `mcp.ts` 的 `McpServerConfig.approval` 扩展为 `boolean | { allow?: string[]; deny?: string[] }`，新增 `needsApprovalFor(toolName, policy)`；缺省 `undefined→true` 向后兼容；connect 时按工具逐个计算注入 `needsApproval`
- [x] **复合工具内部调用绕过审批闸门** → `tools.call(name, args, opts?)` 增加 `internal?: boolean` 选项，`tools/call` 事件携带 `internal`；`tool-analyze-code-dir` 内部三次 serena 调用与 analyze-dir 回退显式 `{ internal: true }`，注释说明「内部委托继承父工具审批状态、有意跳过 agent 循环闸门」
- [x] **会话历史仅事后截断** → `context.ts` 的 `fitContext` 新增 `summarizeDropped`：被裁剪旧消息自动生成「滚动摘要 lite」（统计各工具调用次数，无 LLM 调用），附在 omit 提示后；`agent.ts` 支持 `config.contextBudgetChars`（默认预算，options 优先）并默认开启滚动摘要；`context.test.ts` 已覆盖

## 已搁置（记录原因）

- [x] ~~post-comment 自动刷评论~~：对站点无 SEO 帮助、有 spam 风险——技能保留仅作测试评论管线用
- [x] ~~自评/评论串联提升站点~~：评论区链接 nofollow 不传权重，站内互链走正文

## 已完成的里程碑（2026-08-24）

- [x] monorepo 化（core/web/plugin-hello）+ pnpm workspace 打通
- [x] 工具审批流（human-in-the-loop，超时自动拒绝）
- [x] 流式输出（delta 打字机 + reasoning 思考块）
- [x] 会话持久化（含工具卡/思考块，刷新恢复）
- [x] Markdown 渲染
- [x] 浏览器只读探索（browser-open/screenshot，驱动系统 Chrome）
- [x] Skills 机制（索引注入 prompt + scripts/ 脚本 + UI 展示）
- [x] 插件脚手架（make new-plugin）
- [x] 测试 21 个 + ARCHITECTURE.md + demo-prompts.md + README 重写
