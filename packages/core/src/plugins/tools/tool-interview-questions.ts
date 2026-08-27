import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { Context } from 'cordis'
import { definePlugin } from '../util.js'
import type { Tool, ToolExecutionContext } from '../../types.js'

// …/resolve-studio/packages/core/src/plugins/tools →
// 8 levels up = individuular-invest. Override with LANGGRAPH_PSE_DIR in .env.
const HERE = dirname(fileURLToPath(import.meta.url))
const LANGGRAPH_PSE =
  process.env.LANGGRAPH_PSE_DIR ?? resolve(HERE, '***REMOVED******REMOVED***')
const TASK_DIR = join(LANGGRAPH_PSE, 'tasks', 'interview-questions')
const RUN = join(TASK_DIR, 'run.py')

// Interview question generation is a PSE pipeline (Planner + Specialist +
// Evaluator + Verify) — give it generous headroom.
const RUN_TIMEOUT_MS = 300_000
const MAX_OUTPUT = 64 * 1024

const PROVIDERS = ['free', 'deepseek'] as const
type Provider = (typeof PROVIDERS)[number]

const SUBJECTS = [
  'python',
  'java',
  'javascript',
  'typescript',
  'go',
  'rust',
  'backend',
  'frontend',
  'fullstack',
  'devops',
  'data',
  'ai',
] as const

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
      'Default provider: free (default). ' +
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
          description: 'Model provider: free (default) or deepseek (paid, higher quality).',
          enum: [...PROVIDERS],
          default: 'free',
        },
      },
      required: ['mode'],
    },
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
      const { mode, subject = 'python', jd_text, resume_text, provider = 'free' } = args
      const onProgress = execCtx?.onProgress

      // Validate
      if (mode === 'jd' && !jd_text?.trim()) {
        return 'error: interview-questions jd mode requires jd_text (Job Description content).'
      }
      if (mode === 'resume' && !resume_text?.trim()) {
        return 'error: interview-questions resume mode requires resume_text.'
      }

      // Guard: verify run.py exists
      try {
        await readFile(RUN)
      } catch {
        return `error: interview-questions — run.py not found at ${RUN}. Check LANGGRAPH_PSE_DIR path.`
      }

      // Build command args (always --llm to actually generate)
      const cmdArgs = ['run', 'python', RUN, '--llm', `--provider=${provider}`]
      let tempPath: string | null = null

      if (mode === 'subject') {
        cmdArgs.push(`--subject=${subject}`)
      } else if (mode === 'jd' && jd_text) {
        const tmpDir = await mkdtemp(join(tmpdir(), 'interview-jd-'))
        tempPath = join(tmpDir, 'jd.md')
        await writeFile(tempPath, jd_text, 'utf8')
        cmdArgs.push(`--jd=${tempPath}`)
      } else if (mode === 'resume' && resume_text) {
        const tmpDir = await mkdtemp(join(tmpdir(), 'interview-resume-'))
        tempPath = join(tmpDir, 'resume.md')
        await writeFile(tempPath, resume_text, 'utf8')
        cmdArgs.push(`--resume=${tempPath}`)
      }

      ctx
        .logger('interview-questions')
        .info('starting mode=%s subject=%s provider=%s cwd=%s', mode, subject, provider, TASK_DIR)

      let stdout = ''
      let stderr = ''
      try {
        const child = spawn('uv', cmdArgs, {
          cwd: TASK_DIR,
          env: { ...process.env },
        })

        const timeout = setTimeout(() => {
          child.kill('SIGTERM')
          setTimeout(() => child.kill('SIGKILL'), 5000)
        }, RUN_TIMEOUT_MS)

        child.stdout.on('data', (chunk: Buffer) => {
          const text = chunk.toString()
          stdout += text
          if (stdout.length > MAX_OUTPUT) stdout = stdout.slice(-MAX_OUTPUT)
          onProgress?.(text)
        })
        child.stderr.on('data', (chunk: Buffer) => {
          const text = chunk.toString()
          stderr += text
          if (stderr.length > MAX_OUTPUT) stderr = stderr.slice(-MAX_OUTPUT)
          onProgress?.(text)
        })

        const code = await new Promise<number>((resolve) => {
          child.on('close', resolve)
          child.on('error', () => resolve(-1))
        })
        clearTimeout(timeout)

        if (code !== 0) {
          const errTail = stderr.slice(-500) || stdout.slice(-500)
          return `error: interview-questions exited with code ${code}\n${errTail}`
        }
      } catch (e) {
        return `error: interview-questions spawn failed: ${(e as Error).message}`
      }

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

      const modeLabel = mode === 'subject' ? `按主题(${subject})` : mode === 'jd' ? '按JD' : '按简历'
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
