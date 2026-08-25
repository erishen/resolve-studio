/**
 * Plugin registry — the bridge between `cordis.yml` names and real plugins.
 *
 * DeepSeek Harness composes from a `cordis.yml` where each entry has an `id`,
 * a `name` (the plugin to load), and `config`. The official loader resolves
 * `name` to an installed package; this scaffold resolves it against this local
 * registry instead, which keeps the demo self-contained and runnable.
 */

import type { Plugin } from 'cordis'
import { ToolRegistry } from '../services/tools.js'
import { AgentService } from '../services/agent.js'
import { FastPathService } from '../services/fastpath.js'
import { ApprovalService } from '../services/approval.js'
import { UsageService } from '../services/usage.js'
import { FsRootsService } from '../services/fs-roots.js'
import { skills } from './skills.js'
import { llmMock } from './llm-mock.js'
import { llmOpenAi } from './llm-openai.js'
import { toolEcho } from './tool-echo.js'
import { toolCalculator } from './tool-calculator.js'
import { toolReadFile } from './tool-read-file.js'
import { toolAnalyzeDir } from './tool-analyze-dir.js'
import { toolAnalyzeCodeDir } from './tool-analyze-code-dir.js'
import { toolWriteFile } from './tool-write-file.js'
import { toolShell } from './tool-shell.js'
import { toolHello } from './tool-hello.js'
import { toolBrowser } from './tool-browser.js'
import { toolPickPost } from './tool-pick-post.js'
import { toolSkillRun } from './tool-skill-run.js'
import { toolPortfolioSummary } from './tool-portfolio-summary.js'
import { toolPseReview } from './tool-pse-review.js'
import { mcpPlugin } from './mcp.js'
import { cliChat } from './cli-chat.js'
import { webServer } from './web-server.js'

/** Maps the `name` field in `cordis.yml` to a Cordis plugin. */
export const PLUGINS: Record<string, Plugin> = {
  'tools': ToolRegistry as unknown as Plugin,
  'agent': AgentService as unknown as Plugin,
  'fastpath': FastPathService as unknown as Plugin,
  'approval': ApprovalService as unknown as Plugin,
  'usage': UsageService as unknown as Plugin,
  'fs-roots': FsRootsService as unknown as Plugin,
  'skills': skills as unknown as Plugin,
  'mcp': mcpPlugin as unknown as Plugin,
  'llm-mock': llmMock as unknown as Plugin,
  'llm-openai': llmOpenAi as unknown as Plugin,
  'tool-echo': toolEcho as unknown as Plugin,
  'tool-calculator': toolCalculator as unknown as Plugin,
  'tool-read-file': toolReadFile as unknown as Plugin,
  'tool-analyze-dir': toolAnalyzeDir as unknown as Plugin,
  'tool-analyze-code-dir': toolAnalyzeCodeDir as unknown as Plugin,
  'tool-write-file': toolWriteFile as unknown as Plugin,
  'tool-shell': toolShell as unknown as Plugin,
  'tool-hello': toolHello as unknown as Plugin,
  'tool-browser': toolBrowser as unknown as Plugin,
  'tool-pick-post': toolPickPost as unknown as Plugin,
  'tool-skill-run': toolSkillRun as unknown as Plugin,
  'tool-portfolio-summary': toolPortfolioSummary as unknown as Plugin,
  'tool-pse-review': toolPseReview as unknown as Plugin,
  'cli-chat': cliChat as unknown as Plugin,
  'web-server': webServer as unknown as Plugin,
}

/** Cordis service plugins that form the harness core. */
export const CORE_PLUGINS: Plugin[] = []
