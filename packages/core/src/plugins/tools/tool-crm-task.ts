import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { Context } from 'cordis'
import { definePlugin } from '../util.js'
import { runPseTask, resolvePseDir, gateNonFreeProvider } from './util-pse.js'
import type { Tool, ToolExecutionContext } from '../../types.js'

// Override with LANGGRAPH_PSE_DIR in .env; defaults to the workspace's
// ***REMOVED*** (see util-pse.ts for the resolution rules).
const TASKS_DIR = join(resolvePseDir('langgraph'), 'tasks')

// CRM tasks hit a local backend/DB rather than long LLM pipelines, so they
// get a tighter budget than runPseTask's 5-minute default.
const RUN_TIMEOUT_MS = 180_000

const TASKS = {
  'crm-qa': {
    run: join(TASKS_DIR, 'crm-qa', 'run.py'),
    output: join(TASKS_DIR, 'crm-qa', 'qa_report.md'),
    label: 'CRM 数据质量报告',
    description:
      'Run the langgraph-pse crm-qa pipeline to generate a personal-CRM data quality report. ' +
      'Calls the CRM backend API to fetch deterministic QA metrics, then optionally uses LLM to ' +
      'produce a natural-language report. Use when the user asks about CRM data quality, ' +
      'duplicate contacts, missing fields, or data hygiene.',
  },
  'follow-up-draft': {
    run: join(TASKS_DIR, 'follow-up-draft', 'run.py'),
    output: join(TASKS_DIR, 'follow-up-draft', 'follow_up_drafts.md'),
    label: '跟进消息草稿',
    description:
      'Run the langgraph-pse follow-up-draft pipeline to generate personalized follow-up ' +
      'message drafts for CRM contacts. Reads candidate data from the CRM database and uses ' +
      'LLM to draft context-aware follow-up messages. Use when the user asks to draft follow-up ' +
      'messages, check-in texts, or relationship maintenance content.',
  },
  'weekly-review': {
    run: join(TASKS_DIR, 'weekly-review', 'run.py'),
    output: join(TASKS_DIR, 'weekly-review', 'weekly_review.md'),
    label: '每周关系复盘',
    description:
      'Run the langgraph-pse weekly-review pipeline to generate a weekly relationship review ' +
      'report from CRM data. Aggregates recent interactions, identifies contacts needing ' +
      'follow-up, and produces a natural-language summary. Use when the user asks for a weekly ' +
      'review, relationship summary, or catch-up on contacts.',
  },
} as const

type TaskKey = keyof typeof TASKS
const PROVIDERS = ['free', 'deepseek'] as const
type Provider = (typeof PROVIDERS)[number]

export interface CrmTaskConfig {
  _placeholder?: never
}

const registerCrmTask = (ctx: Context, _config: CrmTaskConfig = {}) => {
  ctx.tools.register({
    name: 'crm-task',
    description:
      'Run one of three langgraph-pse personal-CRM pipelines: ' +
      '(1) crm-qa — data quality report (duplicates, missing fields, hygiene); ' +
      '(2) follow-up-draft — personalized follow-up message drafts for contacts; ' +
      '(3) weekly-review — weekly relationship summary from CRM data. ' +
      'All use the PSE graph (Planner + Specialist + Evaluator + Verify) with anti-hallucination. ' +
      'Default provider: free (default). Requires personal-CRM backend or database to be accessible. ' +
      'Switching to provider="deepseek" (PAID) triggers a human approval prompt — wait for the user ' +
      'to approve before assuming it will run; if rejected, do NOT retry with deepseek. ' +
      'Do NOT read any files before calling this tool.',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Which CRM task to run.',
          enum: Object.keys(TASKS),
        },
        provider: {
          type: 'string',
          description: 'Model provider: free (default) or deepseek (paid, higher quality).',
          enum: [...PROVIDERS],
          default: 'free',
        },
        api_base_url: {
          type: 'string',
          description:
            'CRM backend API base URL (for crm-qa task only). ' +
            'Defaults to CRM_API_BASE_URL env or http://127.0.0.1:8000.',
        },
        db_path: {
          type: 'string',
          description:
            'Path to CRM SQLite database (for follow-up-draft and weekly-review tasks). ' +
            'Defaults to CRM_DB_PATH env or the task\'s default DB path.',
        },
      },
      required: ['task'],
    },
    // Paid (deepseek) runs require human approval; free runs pass through.
    approvalWhen: gateNonFreeProvider('free'),
    async execute(
      args: {
        task: TaskKey
        provider?: Provider
        api_base_url?: string
        db_path?: string
      },
      execCtx?: ToolExecutionContext,
    ): Promise<string> {
      const { task, provider = 'free', api_base_url, db_path } = args
      const onProgress = execCtx?.onProgress
      const cfg = TASKS[task]

      if (!cfg) {
        return `error: unknown crm-task "${task}". Available: ${Object.keys(TASKS).join(', ')}`
      }

      // Build command args (always --llm to generate natural language output).
      // runPseTask prepends `uv run python <run.py>` and owns the guard.
      const cmdArgs = ['--llm', `--provider=${provider}`]
      if (task === 'crm-qa' && api_base_url) {
        cmdArgs.push(`--api-base-url=${api_base_url}`)
      }
      if ((task === 'follow-up-draft' || task === 'weekly-review') && db_path) {
        cmdArgs.push(`--db=${db_path}`)
      }

      const res = await runPseTask({
        // Fold the task name into `tool` so errors read `crm-task crm-qa …`,
        // matching the previous message format.
        tool: `crm-task ${task}`,
        framework: 'langgraph',
        task,
        args: cmdArgs,
        timeoutMs: RUN_TIMEOUT_MS,
        onProgress,
        logger: (msg, ...a) => ctx.logger('crm-task').info(msg, ...a),
      })
      if (!res.ok) return res.error

      const { stdout } = res

      // Read output file
      let outputContent = ''
      try {
        outputContent = await readFile(cfg.output, 'utf8')
      } catch {
        // File might not exist
      }

      const result = [
        `> crm-task 完成（任务：${cfg.label}，模型：${provider}）`,
        `> 输出文件：${cfg.output}`,
        '',
      ]

      if (outputContent) {
        result.push('--- 生成内容（已完整读取，无需再调用 fs:read_text_file）---')
        result.push(outputContent)
      } else {
        result.push('> 注意：未找到输出文件，可能是 CRM 后端/数据库不可用。')
        result.push(stdout.slice(-1500))
      }

      return result.join('\n')
    },
  } as Tool)
}

export const toolCrmTask = definePlugin(registerCrmTask, 'tool-crm-task', ['tools'])
