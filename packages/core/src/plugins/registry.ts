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
import { sandbox } from './sandbox.js'
import { llmMock } from './llm-mock.js'
import { llmOpenAi } from './llm-openai.js'
import { toolEcho } from './tools/tool-echo.js'
import { toolCalculator } from './tools/tool-calculator.js'
import { toolReadFile } from './tools/tool-read-file.js'
import { toolAnalyzeDir } from './tools/tool-analyze-dir.js'
import { toolAnalyzeCodeDir } from './tools/tool-analyze-code-dir.js'
import { toolWriteFile } from './tools/tool-write-file.js'
import { toolShell } from './tools/tool-shell.js'
import { toolHello } from './tools/tool-hello.js'
import { toolSystemInfo } from './tools/tool-system-info.js'
import { toolBrowser } from './tools/tool-browser.js'
import { toolPickPost } from './tools/tool-pick-post.js'
import { toolSkillRun } from './tools/tool-skill-run.js'
import { toolPortfolioCheck } from './tools/tool-portfolio-check.js'
import { toolPseReview } from './tools/tool-pse-review.js'
import { toolArticleWrite } from './tools/tool-article-write.js'
import { toolResumeTailor } from './tools/tool-resume-tailor.js'
import { toolInterviewQuestions } from './tools/tool-interview-questions.js'
import { toolCrmTask } from './tools/tool-crm-task.js'
import { toolWpPublish } from './tools/tool-wp-publish.js'
import { toolCrewAiPublish } from './tools/tool-crewai-publish.js'
import { toolCrewAiDiscover } from './tools/tool-crewai-discover.js'
import { mcpPlugin } from './mcp.js'
import { cliChat } from './cli-chat.js'
import { webServer } from './web-server.js'

/** Maps the `name` field in `cordis.yml` to a Cordis plugin. */
export const PLUGINS: Record<string, Plugin> = {
  tools: ToolRegistry as unknown as Plugin,
  agent: AgentService as unknown as Plugin,
  fastpath: FastPathService as unknown as Plugin,
  approval: ApprovalService as unknown as Plugin,
  usage: UsageService as unknown as Plugin,
  'fs-roots': FsRootsService as unknown as Plugin,
  skills: skills as unknown as Plugin,
  sandbox: sandbox as unknown as Plugin,
  mcp: mcpPlugin as unknown as Plugin,
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
  'tool-portfolio-check': toolPortfolioCheck as unknown as Plugin,
  'tool-pse-review': toolPseReview as unknown as Plugin,
  'tool-article-write': toolArticleWrite as unknown as Plugin,
  'tool-resume-tailor': toolResumeTailor as unknown as Plugin,
  'tool-interview-questions': toolInterviewQuestions as unknown as Plugin,
  'tool-crm-task': toolCrmTask as unknown as Plugin,
  'tool-wp-publish': toolWpPublish as unknown as Plugin,
  'tool-crewai-publish': toolCrewAiPublish as unknown as Plugin,
  'tool-crewai-discover': toolCrewAiDiscover as unknown as Plugin,
  'tool-system-info': toolSystemInfo as unknown as Plugin,
  'cli-chat': cliChat as unknown as Plugin,
  'web-server': webServer as unknown as Plugin,
}

/** Cordis service plugins that form the harness core. */
export const CORE_PLUGINS: Plugin[] = []
