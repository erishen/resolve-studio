import type { SkillInfo } from './api'
import type { ToolSchema } from './types'

export interface ExampleItem {
  id: string
  /** Short label shown on the card (usually the tool/skill name). */
  title: string
  /** The actual prompt that gets dropped into the input when picked. */
  prompt: string
}

function humanize(name: string): string {
  return name.replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim()
}

function skillExample(s: SkillInfo): ExampleItem | null {
  const blob = (s.name + ' ' + (s.description ?? '')).toLowerCase()
  let prompt: string
  if (/review|audit|lint/.test(blob)) {
    prompt = `请使用 ${s.name} 技能，对当前改动做一次审查，并给出可落地的改进建议。`
  } else if (/research|investigat|survey|search/.test(blob)) {
    prompt = `请使用 ${s.name} 技能，调研相关主题并整理出结论与参考。`
  } else if (/summar/.test(blob)) {
    prompt = `请使用 ${s.name} 技能，总结指定内容的要点。`
  } else if (/generat|create|build|write|draft/.test(blob)) {
    prompt = `请使用 ${s.name} 技能，帮我生成所需的内容或代码。`
  } else if (/fix|debug|repair|resolve/.test(blob)) {
    prompt = `请使用 ${s.name} 技能，定位并修复存在的问题。`
  } else if (/explain|analy/.test(blob)) {
    prompt = `请使用 ${s.name} 技能，分析并解释其中的原理。`
  } else {
    prompt = `请使用 ${s.name} 技能完成相关任务。`
  }
  return { id: 'skill:' + s.name, title: humanize(s.name), prompt }
}

function toolExample(t: ToolSchema): ExampleItem | null {
  const blob = (t.name + ' ' + (t.description ?? '')).toLowerCase()
  let prompt: string
  if (/code.dir|code_dir/.test(blob)) {
    prompt = `用符号/诊断等语义分析深入理解一个代码目录的结构。`
  } else if (/(analy|scan|directory|folder|list.*files|tree)/.test(blob)) {
    prompt = `分析一个目录的结构与关键文件，并总结它做了什么。`
  } else if (/(read|cat|load|get_file|view)/.test(blob)) {
    prompt = `读取指定文件的内容，并总结它做了什么。`
  } else if (/(write|edit|create|save|update|patch)/.test(blob)) {
    prompt = `帮我在项目里新建或修改一个文件。`
  } else if (/(shell|exec|bash|run|terminal|command|cmd)/.test(blob)) {
    prompt = `在终端执行命令并解释它的输出。`
  } else if (/(search|grep|find|locate)/.test(blob)) {
    prompt = `在代码库中搜索某段逻辑的定义与用法。`
  } else if (/(fetch|http|web|browser|scrap|url|crawl)/.test(blob)) {
    prompt = `抓取一个网页并提取关键信息。`
  } else if (/(sql|db|query|database|pg|mysql)/.test(blob)) {
    prompt = `查询数据库并返回结果。`
  } else if (/(review|lint|test|check|verify)/.test(blob)) {
    prompt = `对当前改动运行 ${t.name} 检查。`
  } else if (/(skill|agent|invoke)/.test(blob)) {
    prompt = `调用 ${t.name} 来完成任务。`
  } else {
    return null
  }
  return { id: 'tool:' + t.name, title: humanize(t.name), prompt }
}

/**
 * Build up to 6 example prompts from the runtime's skills and built-in tools.
 * MCP tools are namespaced (e.g. "fs:read") and skipped — their names are
 * dynamic and would produce noisy labels.
 */
export function buildExamples(tools: ToolSchema[], skills: SkillInfo[]): ExampleItem[] {
  const out: ExampleItem[] = []
  for (const s of skills) {
    const e = skillExample(s)
    if (e) out.push(e)
  }
  for (const t of tools) {
    if (t.name.includes(':')) continue
    const e = toolExample(t)
    if (e) out.push(e)
  }
  const seen = new Set<string>()
  const uniq = out.filter((e) => {
    if (seen.has(e.prompt)) return false
    seen.add(e.prompt)
    return true
  })
  return uniq.slice(0, 6)
}

/** Shown when no tools/skills are available to derive examples from. */
export const FALLBACK_EXAMPLES: ExampleItem[] = [
  { id: 'fb1', title: '代码审查', prompt: '请对当前改动做一次代码审查，指出风险与改进点。' },
  { id: 'fb2', title: '解释代码', prompt: '请解释某个模块的核心逻辑与数据流。' },
  { id: 'fb3', title: '写测试', prompt: '为指定函数编写单元测试。' },
  { id: 'fb4', title: '生成文档', prompt: '为这个项目生成一份简短的使用说明。' },
]
