import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { Context } from 'cordis'
import { definePlugin } from '../util.js'
import { runPseTask, writeTempText, gateNonFreeProvider } from './util-pse.js'
import type { Tool, ToolExecutionContext } from '../../types.js'

// Interview question generation is a PSE pipeline (Planner + Specialist +
// Evaluator + Verify); runPseTask defaults to a generous 5-minute budget.

const PROVIDERS = ['agnes', 'deepseek'] as const
type Provider = (typeof PROVIDERS)[number]

const SUBJECTS = ['python', 'go', 'java', 'typescript', 'backend', 'frontend', 'sre'] as const

export interface InterviewQuestionsConfig {
  _placeholder?: never
}

const registerInterviewQuestions = (ctx: Context, _config: InterviewQuestionsConfig = {}) => {
  ctx.tools.register({
    name: 'interview-questions',
    description:
      'Run the langgraph-pse interview-questions pipeline (Planner + Specialist + Evaluator + Verify) ' +
      'to generate a structured technical interview question set. Supports three modes: ' +
      '(1) by subject (programming language / role), ' +
      '(2) by Job Description (JD text), ' +
      '(3) by resume text. ' +
      'Generates 9 questions (3 easy / 3 medium / 3 hard) with anti-hallucination topic verification. ' +
      'Takes 1-5 minutes. Returns the generated question set (Markdown) and save path. ' +
      'Use when the user asks to generate interview questions, prepare for an interview, or create a quiz. ' +
      'Default provider: agnes (free). ' +
      'Switching to provider="deepseek" (PAID) triggers a human approval prompt — wait for the user ' +
      'to approve before assuming it will run; if rejected, do NOT retry with deepseek. ' +
      'Do NOT read any files before calling this tool — all paths and configs are handled internally.',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          description:
            'Generation mode: "subject" = by programming language/role; ' +
            '"jd" = by Job Description text; "resume" = by resume text.',
          enum: ['subject', 'jd', 'resume'],
          default: 'subject',
        },
        subject: {
          type: 'string',
          description:
            'Subject for "subject" mode: programming language (python/java/javascript/typescript/go/rust) ' +
            'or role (backend/frontend/fullstack/devops/data/ai).',
          enum: [...SUBJECTS],
          default: 'python',
        },
        jd_text: {
          type: 'string',
          description: 'Job Description text for "jd" mode. Required when mode="jd".',
        },
        resume_text: {
          type: 'string',
          description: 'Resume content text for "resume" mode. Required when mode="resume".',
        },
        provider: {
          type: 'string',
          description: 'Model provider: agnes (default/free) or deepseek (paid, higher quality).',
          enum: [...PROVIDERS],
          default: 'agnes',
        },
      },
      required: ['mode'],
    },
    // Paid (deepseek) runs require human approval; free (agnes) runs pass through.
    approvalWhen: gateNonFreeProvider('agnes'),
    async execute(
      args: {
        mode: 'subject' | 'jd' | 'resume'
        subject?: string
        jd_text?: string
        resume_text?: string
        provider?: Provider
      },
      execCtx?: ToolExecutionContext,
    ): Promise<string> {
      const { mode, subject = 'python', jd_text, resume_text, provider = 'agnes' } = args
      const onProgress = execCtx?.onProgress

      // Validate
      if (mode === 'jd' && !jd_text?.trim()) {
        return 'error: interview-questions jd mode requires jd_text (Job Description content).'
      }
      if (mode === 'resume' && !resume_text?.trim()) {
        return 'error: interview-questions resume mode requires resume_text.'
      }

      // Build command args (always --llm to actually generate).
      // runPseTask prepends `uv run python <run.py>` and owns the run.py guard.
      const cmdArgs = ['--llm', `--provider=${provider}`]

      if (mode === 'subject') {
        cmdArgs.push(`--subject=${subject}`)
      } else if (mode === 'jd' && jd_text) {
        const jdPath = await writeTempText('interview-jd-', 'jd.md', jd_text)
        cmdArgs.push(`--jd=${jdPath}`)
      } else if (mode === 'resume' && resume_text) {
        const resumePath = await writeTempText('interview-resume-', 'resume.md', resume_text)
        cmdArgs.push(`--resume=${resumePath}`)
      }

      const res = await runPseTask({
        tool: 'interview-questions',
        framework: 'langgraph',
        task: 'interview-questions',
        args: cmdArgs,
        onProgress,
        logger: (msg, ...a) => ctx.logger('interview-questions').info(msg, ...a),
      })
      if (!res.ok) return res.error

      const { stdout, taskDir: TASK_DIR } = res

      // Determine output file
      let outFile: string | null = null
      if (mode === 'resume') {
        // Extract title from output or use default
        const match = stdout.match(/interview_questions_resume_(\w+)\.md/)
        const title = match ? match[1] : 'custom'
        outFile = join(TASK_DIR, `interview_questions_resume_${title}.md`)
      } else if (mode === 'jd') {
        const match = stdout.match(/interview_questions_jd_(\w+)\.md/)
        const title = match ? match[1] : 'custom'
        outFile = join(TASK_DIR, `interview_questions_jd_${title}.md`)
      } else {
        outFile = join(TASK_DIR, `interview_questions_${subject}.md`)
      }

      // Read output
      let outputContent = ''
      try {
        outputContent = await readFile(outFile, 'utf8')
      } catch {
        // Try to find any recently generated file
        outFile = null
      }

      // Count questions (### Q1, ### Q2, ...)
      const questionMatches = outputContent.match(/^###\s*Q\d+/gm) ?? []
      const questionCount = questionMatches.length
      const EXPECTED = 9

      const modeLabel =
        mode === 'subject' ? `按主题(${subject})` : mode === 'jd' ? '按JD' : '按简历'
      const result = [
        `> interview-questions 完成（模式：${modeLabel}，模型：${provider}）`,
        outFile ? `> 输出文件：${outFile}` : '> 注意：未找到输出文件',
        questionCount > 0
          ? `> 题目数量：${questionCount}/${EXPECTED}${questionCount < EXPECTED ? ' ⚠️ 不完整，建议重试' : ''}`
          : '> ⚠️ 未检测到题目，生成可能失败',
        '',
      ]

      if (outputContent) {
        result.push('--- 生成内容（已完整读取，无需再调用 fs:read_text_file）---')
        result.push(outputContent)
      } else {
        result.push('> 流水线输出：')
        result.push(stdout.slice(-1500))
      }

      return result.join('\n')
    },
  } as Tool)
}

export const toolInterviewQuestions = definePlugin(
  registerInterviewQuestions,
  'tool-interview-questions',
  ['tools'],
)
