import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { Context } from 'cordis'
import { definePlugin } from '../util.js'
import type { Tool, ToolExecutionContext } from '../../types.js'

// …/resolve-studio/packages/core/src/plugins/tools →
// 8 levels up = ***REMOVED***. Override with LLAMAINDEX_PSE_DIR in .env.
const HERE = dirname(fileURLToPath(import.meta.url))
const LLAMAINDEX_PSE =
  process.env.LLAMAINDEX_PSE_DIR ?? resolve(HERE, '***REMOVED******REMOVED***')
const RESUME_TAILOR_DIR = join(LLAMAINDEX_PSE, 'tasks', 'resume-tailor')
const RUN = join(RESUME_TAILOR_DIR, 'run.py')

// Resume tailoring is a RAG + LLM pipeline — give it generous headroom.
const RUN_TIMEOUT_MS = 300_000
const MAX_OUTPUT = 64 * 1024

const PROVIDERS = ['free', 'deepseek', 'scnet-kimi', 'scnet-minimax'] as const
type Provider = (typeof PROVIDERS)[number]

export interface ResumeTailorConfig {
  _placeholder?: never
}

const registerResumeTailor = (ctx: Context, _config: ResumeTailorConfig = {}) => {
  ctx.tools.register({
    name: 'resume-tailor',
    description:
      'Run the llamaindex-pse resume-tailor pipeline (RAG + LLM) to either: ' +
      '(1) customize a resume for a specific Job Description (JD), or ' +
      '(2) recommend best-fit positions based on your experience. ' +
      'Takes 1-5 minutes. Returns the generated resume (Markdown) and save path. ' +
      'Use when the user asks to tailor/optimize a resume for a job, or asks for ' +
      'job/career recommendations. Default provider: free (default). ' +
      'Do NOT read any files before calling this tool — all paths and configs are handled internally.',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          description:
            'Operation mode: "customize" = tailor resume for a JD (requires jd_text); ' +
            '"recommend" = recommend best-fit positions (no JD needed).',
          enum: ['customize', 'recommend'],
        },
        jd_text: {
          type: 'string',
          description:
            'Job Description text for customize mode. Required when mode="customize". ' +
            'Paste the full JD content here.',
        },
        provider: {
          type: 'string',
          description: 'Model provider: free (default), deepseek, scnet-kimi, scnet-minimax.',
          enum: [...PROVIDERS],
          default: 'free',
        },
      },
      required: ['mode'],
    },
    async execute(
      args: { mode: 'customize' | 'recommend'; jd_text?: string; provider?: Provider },
      execCtx?: ToolExecutionContext,
    ): Promise<string> {
      const { mode, jd_text, provider = 'free' } = args
      const onProgress = execCtx?.onProgress

      // Validate
      if (mode === 'customize' && !jd_text?.trim()) {
        return 'error: resume-tailor customize mode requires jd_text (Job Description content).'
      }

      // Guard: verify run.py exists
      try {
        await readFile(RUN)
      } catch {
        return `error: resume-tailor — run.py not found at ${RUN}. Check LLAMAINDEX_PSE_DIR path.`
      }

      // Build command args
      const cmdArgs = ['run', 'python', RUN, `--provider=${provider}`]
      let tempJdPath: string | null = null

      if (mode === 'customize' && jd_text) {
        // Write JD to temp file
        const tmpDir = await mkdtemp(join(tmpdir(), 'resume-jd-'))
        tempJdPath = join(tmpDir, 'jd.md')
        await writeFile(tempJdPath, jd_text, 'utf8')
        cmdArgs.push(`--jd=${tempJdPath}`)
      } else if (mode === 'recommend') {
        cmdArgs.push('--recommend')
      }

      ctx
        .logger('resume-tailor')
        .info('starting mode=%s provider=%s cwd=%s', mode, provider, RESUME_TAILOR_DIR)

      let stdout = ''
      let stderr = ''
      try {
        const child = spawn('uv', cmdArgs, {
          cwd: RESUME_TAILOR_DIR,
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
          return `error: resume-tailor exited with code ${code}\n${errTail}`
        }
      } catch (e) {
        return `error: resume-tailor spawn failed: ${(e as Error).message}`
      }

      // Determine output file
      const outFile =
        mode === 'recommend'
          ? join(RESUME_TAILOR_DIR, `recommended_resume_${provider}.md`)
          : join(RESUME_TAILOR_DIR, `tailored_resume_${provider}.md`)

      // Read output
      let outputContent = ''
      try {
        outputContent = await readFile(outFile, 'utf8')
      } catch {
        // File might not exist if pipeline failed silently
      }

      const modeLabel = mode === 'recommend' ? '岗位推荐' : '简历定制'
      const result = [
        `> resume-tailor 完成（模式：${modeLabel}，模型：${provider}）`,
        `> 输出文件：${outFile}`,
        '',
      ]

      if (outputContent) {
        result.push('--- 生成内容预览（前 2000 字）---')
        result.push(outputContent.slice(0, 2000))
        if (outputContent.length > 2000) {
          result.push(`\n... (共 ${outputContent.length} 字，完整内容见输出文件)`)
        }
      } else {
        result.push('> 注意：未找到输出文件，可能是流水线未生成成品。')
        result.push(stdout.slice(-1000))
      }

      return result.join('\n')
    },
  } as Tool)
}

export const toolResumeTailor = definePlugin(registerResumeTailor, 'tool-resume-tailor', ['tools'])
