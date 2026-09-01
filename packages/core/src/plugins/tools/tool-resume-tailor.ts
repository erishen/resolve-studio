import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { Context } from 'cordis'
import { definePlugin } from '../util.js'
import { runPseTask, writeTempText, gateNonFreeProvider } from './util-pse.js'
import type { Tool, ToolExecutionContext } from '../../types.js'

// Resume tailoring is a RAG + LLM pipeline; runPseTask defaults to 5 minutes.

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
      'Any non-free provider (deepseek / scnet-kimi / scnet-minimax) is PAID and triggers a human ' +
      'approval prompt — wait for the user to approve before assuming it will run; if rejected, ' +
      'do NOT retry with a paid provider. ' +
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
    // Any non-free provider (deepseek / scnet-*) is paid and requires approval.
    approvalWhen: gateNonFreeProvider('free'),
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

      // Build command args. runPseTask prepends `uv run python <run.py>`
      // and owns the run.py guard.
      const cmdArgs = [`--provider=${provider}`]

      if (mode === 'customize' && jd_text) {
        // Stage the JD in a temp file — the pipeline takes a path, not text.
        cmdArgs.push(`--jd=${await writeTempText('resume-jd-', 'jd.md', jd_text)}`)
      } else if (mode === 'recommend') {
        cmdArgs.push('--recommend')
      }

      const res = await runPseTask({
        tool: 'resume-tailor',
        framework: 'llamaindex',
        task: 'resume-tailor',
        args: cmdArgs,
        onProgress,
        logger: (msg, ...a) => ctx.logger('resume-tailor').info(msg, ...a),
      })
      if (!res.ok) return res.error

      const { stdout } = res

      // Determine output file
      const outFile =
        mode === 'recommend'
          ? join(res.taskDir, `recommended_resume_${provider}.md`)
          : join(res.taskDir, `tailored_resume_${provider}.md`)

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
