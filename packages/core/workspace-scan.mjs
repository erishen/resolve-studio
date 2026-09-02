// resolve-studio 工作区代码分析合集生成器（v3：语言单元化 + 混仓分别激活）
//
// 收录规则（来自用户）：
//   - 仅收录「有 GitHub 链接 + 已写文章」的项目，清单即 ***REMOVED*** 的
//     tasks/project-articles/projects-published.json（该清单本身已排除 github/、cnb/ 下的 fork/镜像副本）。
//   - 逐项目探测「语言分析单元」：根目录 + 深度≤2 子目录内的构建标记，每个语言各成一个单元。
//     单语言仓库 → 单一 serena 进程（行为同 v2）；混仓（如 market-analyzer：根 pyproject + frontend/ package.json）
//     → 每个语言单元各自起一个独立的 serena 进程，仅抽样该语言文件，再合并展示（即「分别激活两次」）。
//   - Rust/Go：本机已装 rust-analyzer / gopls 后，真正跑 serena 取符号；Java/Kotlin 无独立 jdtls → 仅列结构。
//   - Python/TS/JS 的 LSP 随 serena 的 uv 环境提供，始终可用。
//
// 运行（须从 packages/core，gopls 在 ~/go/bin 须进 PATH）：
//   export PATH="$HOME/go/bin:$PATH"
//   SERENA_UV=/path/to/uv node workspace-scan.mjs
//   # 仅验证部分项目：追加  SCAN_ONLY=photo-library,cicdkit,market-analyzer
//
// 所有机器相关路径一律走环境变量，默认值对一份全新 clone 即可用（不写死任何用户目录）：
//   WORKSPACE_ROOT     要扫描的工作区根目录（默认：本仓库根）
//   WORKSPACE_MANIFEST 项目清单 JSON（默认：<WORKSPACE_ROOT>/***REMOVED***/...）
//   WORKSPACE_OUT      产物输出目录（默认：<本仓库根>/workspace-analysis）
//   SERENA_DIR         serena 源码目录（默认：~/Github/serena）
//   WORKSPACE_LLM_ENV  读取 OPENAI_* 的 .env（默认：<本仓库根>/.env）
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, relative, basename, extname, resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const UV = process.env.SERENA_UV || 'uv'
// 本仓库根（workspace-scan.mjs 位于 packages/core/ 下）
const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const ROOT = process.env.WORKSPACE_ROOT || REPO_ROOT
const MANIFEST =
  process.env.WORKSPACE_MANIFEST ||
  join(ROOT, '***REMOVED***/tasks/project-articles/projects-published.json')
const OUT_DIR = process.env.WORKSPACE_OUT || join(REPO_ROOT, 'workspace-analysis')
const SERENA_DIR = process.env.SERENA_DIR || join(homedir(), 'Github', 'serena')
const LLM_ENV = process.env.WORKSPACE_LLM_ENV || join(REPO_ROOT, '.env')

const MAX_FILES = 10 // 每语言单元抽样分析的文件数
const SYM_CHARS = 1800
const DIAG_CHARS = 4000 // 诊断 JSON 可能很长，给够空间让 JSON.parse 成功以支持过滤
const PROJECT_TIMEOUT = 120000 // 单语言单元硬超时（含 LSP 启动），避免卡死

const EXT = {
  '.ts': 1,
  '.tsx': 1,
  '.js': 1,
  '.jsx': 1,
  '.mjs': 1,
  '.cjs': 1,
  '.py': 1,
  '.rs': 1,
  '.go': 1,
  '.java': 1,
  '.kt': 1,
  '.php': 1,
  '.rb': 1,
  '.cs': 1,
  '.md': 1,
}
// 依赖/构建产物/缓存目录：扫描源文件与探测语言单元时一律跳过。
const SKIP = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'target',
  'venv',
  '.venv',
  '__pycache__',
  '.ruff_cache',
  '.mypy_cache',
  '.serena',
  'coverage',
  'vendor',
  'out',
  'site-packages',
  '.turbo',
  '.output',
  '.cache',
  '.gradle',
  '.idea',
  '.vscode',
  '.pytest_cache',
  '.tox',
  '.nyc_output',
  '.parcel-cache',
  '.svelte-kit',
  '.vite',
  '.DS_Store',
]
// 目录是否应跳过：点号目录 + 黑名单 + Python 构建产物（<pkg>.egg-info / .egg）。
function shouldSkip(name) {
  return (
    name.startsWith('.') ||
    SKIP.includes(name) ||
    name.endsWith('.egg-info') ||
    name.endsWith('.egg')
  )
}
// 文件级噪声过滤：压缩产物与 TS 声明文件不进抽样（无分析价值）。
function isNoiseFile(name) {
  return /\.min\.(js|css|mjs|cjs)$/.test(name) || name.endsWith('.d.ts')
}

// ---- 可中断支持：收到 SIGTERM（来自后端 /api/workspace/stop）即中止扫描 ----
// 处理时立即杀掉当前 serena 进程树（含 LSP 孙进程）并置 aborted；本轮正在
// await 的 LSP 调用会因连接断开很快 reject，主循环在下一轮检查 aborted 即退出。
// 已完成的增量结果早已落盘，不会丢失。3s 硬超时兜底确保无论如何都退出并写入
// terminated 状态（避免 serena 未如预期退出时整轮挂死）。
let aborted = false
let currentSerenaPid = null
function killCurrentSerena() {
  if (currentSerenaPid != null) {
    killTree(currentSerenaPid)
    currentSerenaPid = null
  }
}
process.on('SIGTERM', () => {
  if (aborted) return
  aborted = true
  console.error('[scan] 收到 SIGTERM，正在中断扫描…')
  killCurrentSerena()
  // 兜底：SIGTERM 可能在 connect 阶段（currentSerenaPid 尚未赋值）到达，
  // 此时直接杀「本进程的子进程里所有 serena」以确保 LSP 孙进程被清理，不留孤儿。
  try {
    const kids = execSync(`pgrep -P ${process.pid}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean)
    for (const k of kids) {
      try {
        killTree(parseInt(k, 10))
      } catch {}
    }
  } catch {}
  setTimeout(() => {
    // 兜底再清一次：万一 SIGTERM 后仍有极短窗口内 spawn 的 serena 孙进程，
    // 退出前把它们一并杀掉，绝对不留孤儿。
    try {
      const kids = execSync(`pgrep -P ${process.pid}`, { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim()
        .split('\n')
        .filter(Boolean)
      for (const k of kids) {
        try {
          killTree(parseInt(k, 10))
        } catch {}
      }
    } catch {}
    try {
      writeStatus({
        status: 'terminated',
        startedAt,
        pid: process.pid,
        total: projects.length,
        current: results.length,
        currentKey: '',
        processed: results.map((r) => r.key),
        skipped,
      })
    } catch {}
    process.exit(0)
  }, 3000)
})

// 项目源码指纹：用于「跳过未变更项目」。优先用 git HEAD（提交哈希，最精准），
// 非 git 仓库回退到「源文件最大 mtime + 文件数」的廉价统计签名。
// 返回 null 表示目录不存在或无法取指纹（此时不应走缓存跳过分支）。
function projectSignature(absDir) {
  if (!existsSync(absDir)) return null
  try {
    const head = execSync(`git -C ${JSON.stringify(absDir)} rev-parse HEAD`, {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    })
      .toString()
      .trim()
    if (head) return 'git:' + head
  } catch {}
  let maxM = 0,
    n = 0
  const walk = (d, depth) => {
    if (depth > 7 || n > 3000) return
    let ents = []
    try {
      ents = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      if (shouldSkip(e.name)) continue
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (EXT[extname(e.name)] && !isNoiseFile(e.name)) {
        n++
        try {
          const m = statSync(p).mtimeMs
          if (m > maxM) maxM = m
        } catch {}
      }
    }
  }
  walk(absDir, 0)
  return 'stat:' + maxM + ':' + n
}

// 上轮该条目是否「曾成功产出过分析」（无论深度/结构/缺失，都算可复用的稳定结果）。
// 仅当上轮是致命错误（无条目）时才不算——但本实现总会落盘条目，故只要存在即复用。
function isReusable(r) {
  return !!(r && r.key)
}

// 语言 → 用于抽样过滤的扩展名
const LANG_EXT = {
  Rust: ['.rs'],
  Go: ['.go'],
  Python: ['.py'],
  TypeScript: ['.ts', '.tsx'],
  JavaScript: ['.js', '.jsx', '.mjs', '.cjs'],
  'Java/Kotlin': ['.java', '.kt'],
  Markdown: ['.md'],
}

// 该语言能否真正跑 LSP（rust/go/jdtls 是系统二进制，须在 PATH；其余随 serena 环境提供）
function hasBin(b) {
  try {
    execSync(`command -v ${b}`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
function lspAvailable(lang) {
  if (lang === 'Rust') return hasBin('rust-analyzer')
  if (lang === 'Go') return hasBin('gopls')
  if (lang === 'Java/Kotlin') return hasBin('jdtls')
  if (lang === 'Markdown') return false // Markdown 无 LSP，仅列文件结构
  return true // Python / TS / JS：serena uv 环境内置
}

// ---- 语言单元探测 ----
// 返回 [{lang, dir}]，按语言去重（首个命中的目录优先）。扫描根目录 + 深度≤2 子目录。
function markerAt(dir) {
  if (!existsSync(dir)) return null
  if (existsSync(join(dir, 'Cargo.toml'))) return 'Rust'
  if (existsSync(join(dir, 'go.mod'))) return 'Go'
  if (existsSync(join(dir, 'pyproject.toml')) || existsSync(join(dir, 'requirements.txt')))
    return 'Python'
  if (existsSync(join(dir, 'pom.xml')) || existsSync(join(dir, 'build.gradle')))
    return 'Java/Kotlin'
  if (existsSync(join(dir, 'package.json'))) {
    let ts = 0,
      js = 0
    const wc = (d, depth = 0) => {
      if (depth > 2) return
      try {
        for (const f of readdirSync(d, { withFileTypes: true })) {
          if (f.isDirectory()) {
            if (shouldSkip(f.name)) continue
            wc(join(d, f.name), depth + 1)
          } else if (f.name.endsWith('.ts') || f.name.endsWith('.tsx')) ts++
          else if (
            f.name.endsWith('.js') ||
            f.name.endsWith('.jsx') ||
            f.name.endsWith('.mjs') ||
            f.name.endsWith('.cjs')
          )
            js++
        }
      } catch {}
    }
    wc(dir)
    return ts >= js ? 'TypeScript' : 'JavaScript'
  }
  return null
}

function detectUnits(root) {
  if (!existsSync(root)) return []
  const units = []
  const seen = new Set()
  const push = (lang, dir) => {
    if (lang && !seen.has(lang)) {
      seen.add(lang)
      units.push({ lang, dir })
    }
  }
  push(markerAt(root), root)
  const walk = (d, depth) => {
    if (depth > 2) return
    let entries = []
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (shouldSkip(e.name) || !e.isDirectory()) continue
      const p = join(d, e.name)
      push(markerAt(p), p)
      walk(p, depth + 1)
    }
  }
  walk(root, 1)
  return units
}

// 本地列源文件（结构展示用，不依赖 LSP）；exts 提供时仅返回该语言文件
function listSources(dir, max = 400, exts) {
  const out = []
  const walk = (d, depth = 0) => {
    if (depth > 7 || out.length >= max) return
    try {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (shouldSkip(e.name)) continue
        const p = join(d, e.name)
        if (e.isDirectory()) walk(p, depth + 1)
        else if (
          !isNoiseFile(e.name) &&
          EXT[extname(e.name)] &&
          (!exts || exts.includes(extname(e.name)))
        )
          out.push(p)
      }
    } catch {}
  }
  walk(dir)
  return out
}

function txt(r) {
  if (r.isError)
    return {
      err: true,
      text:
        r.content?.[0]?.text ?? (r.structuredContent ? JSON.stringify(r.structuredContent) : ''),
    }
  const text = (r.content ?? []).map((c) => c.text ?? '').join('\n')
  if (text.trim()) return { err: false, text }
  if (r.structuredContent !== undefined)
    return {
      err: false,
      text:
        typeof r.structuredContent === 'string'
          ? r.structuredContent
          : JSON.stringify(r.structuredContent, null, 2),
    }
  return { err: false, text: '' }
}

// 从 serena 的 get_symbols_overview 结果（JSON 字符串，如 {"Function":[...],"Class":[...]}）
// 中统计真实顶层符号数。符号文本是单行 JSON，不能靠换行计数（旧实现 bug）。
function countSymbols(symbols) {
  if (!symbols || !symbols.trim()) return 0
  try {
    const obj = JSON.parse(symbols)
    if (obj && typeof obj === 'object') {
      return Object.values(obj).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0)
    }
  } catch {
    /* 非 JSON 时退回数引号标识符 */
  }
  return (symbols.match(/"[^"\n]+"/g) || []).length
}

// ---- 增强分析：符号摘要 + 代码质量 + 模块依赖 ----

/**
 * 从文件内容中提取每个顶层符号的 docstring/首行注释摘要。
 * 支持 Python（def/class 后的三引号 docstring）和 JS/TS（函数前的 // 或 /* 注释）。
 * 返回 { symbolName: summary } 映射。
 */
function extractSymbolSummaries(content, lang) {
  const summaries = {}
  const lines = content.split('\n')

  if (lang === 'Python') {
    // 匹配顶层 def/class（不缩进）
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(?:async\s+)?(?:def|class)\s+(\w+)/)
      if (!m) continue
      const name = m[1]
      // 找下一行的 docstring（三引号）
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const trimmed = lines[j].trim()
        const dm = trimmed.match(/^"""([^"]*)"""?$/) || trimmed.match(/^'''([^']*)'''?$/)
        if (dm) {
          summaries[name] = dm[1].trim().slice(0, 100)
          break
        }
        // 单行三引号开头
        const dmStart = trimmed.match(/^"""([^"]*)$/) || trimmed.match(/^'''([^']*)$/)
        if (dmStart) {
          let doc = dmStart[1].trim()
          for (let k = j + 1; k < Math.min(j + 10, lines.length); k++) {
            if (lines[k].includes('"""') || lines[k].includes("'''")) {
              const end = lines[k].split(/"""|'''/)[0]
              doc = (doc + ' ' + end).trim()
              break
            }
            doc += ' ' + lines[k].trim()
          }
          summaries[name] = doc.slice(0, 100)
          break
        }
        if (trimmed && !trimmed.startsWith('#')) break
      }
      // 没有 docstring，尝试取上方注释
      if (!summaries[name]) {
        for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
          const cm = lines[j].trim().match(/^#\s*(.+)$/)
          if (cm) {
            summaries[name] = cm[1].trim().slice(0, 100)
            break
          }
          if (lines[j].trim()) break
        }
      }
    }
  } else if (lang === 'JavaScript' || lang === 'TypeScript') {
    // 匹配 function/const/export function 等
    for (let i = 0; i < lines.length; i++) {
      const m =
        lines[i].match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/) ||
        lines[i].match(/^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/) ||
        lines[i].match(/^(?:export\s+)?class\s+(\w+)/)
      if (!m) continue
      const name = m[1]
      // 取上方 JSDoc 或行注释
      for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
        const trimmed = lines[j].trim()
        if (trimmed.startsWith('//')) {
          summaries[name] = trimmed.replace(/^\/\/+\s*/, '').slice(0, 100)
          break
        }
        if (trimmed.startsWith('*') || trimmed.startsWith('/*')) {
          // JSDoc：收集 * 开头的行
          let doc = ''
          for (let k = j; k >= Math.max(0, j - 10); k--) {
            const t = lines[k].trim()
            if (t.startsWith('*')) doc = t.replace(/^\*+\s*/, '') + ' ' + doc
            else if (t.startsWith('/*')) break
            else break
          }
          summaries[name] = doc.trim().slice(0, 100)
          break
        }
        if (trimmed) break
      }
    }
  }
  return summaries
}

/**
 * 解析文件的 import 语句，返回模块依赖列表。
 * Python: from x import y / import x
 * JS/TS: import x from 'y' / require('y')
 */
function parseImports(content, lang) {
  const imports = new Set()
  if (lang === 'Python') {
    const re = /^(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm
    let m
    while ((m = re.exec(content)) !== null) {
      const mod = m[1] || m[2]
      if (mod && !mod.startsWith('_')) imports.add(mod)
    }
  } else if (lang === 'JavaScript' || lang === 'TypeScript') {
    const re = /(?:import\s+(?:.+?\s+from\s+)?|require\s*\(\s*)['"]([^'"]+)['"]/g
    let m
    while ((m = re.exec(content)) !== null) {
      if (m[1] && !m[1].startsWith('.')) imports.add(m[1])
    }
  }
  return [...imports]
}

/**
 * 综合提取文件洞察：符号摘要、行数、import 依赖、是否测试文件。
 */
function extractFileInsights(absPath, lang) {
  try {
    const content = readFileSync(absPath, 'utf8')
    const lines = content.split('\n')
    const rel = basename(absPath)
    return {
      lineCount: lines.length,
      summaries: extractSymbolSummaries(content, lang),
      imports: parseImports(content, lang),
      isTest: /(?:^|[\\/])(?:test|tests?|__tests__)[\\/]/.test(absPath) || /\.test\.\w+$/.test(rel) || /_test\.\w+$/.test(rel),
    }
  } catch {
    return { lineCount: 0, summaries: {}, imports: [], isTest: false }
  }
}

/**
 * 判断文件是否为核心入口文件。
 * 基于文件名（cli/main/orchestrator/app/index）和符号名（main/run/create_app）。
 */
function isCoreEntry(rel, symbols) {
  const name = basename(rel).toLowerCase()
  const coreNames = ['cli', 'main', 'orchestrator', 'app', 'index', 'server', 'run', '__main__']
  if (coreNames.some((n) => name.startsWith(n) || name === n + '.py' || name === n + '.js' || name === n + '.jsx' || name === n + '.ts' || name === n + '.tsx')) {
    return true
  }
  // 检查是否包含核心符号
  if (symbols) {
    try {
      const obj = JSON.parse(symbols)
      const allSyms = Object.values(obj).flat()
      const coreSyms = ['main', 'run_task', 'create_app', 'create_pse_team', 'run', 'start']
      if (allSyms.some((s) => coreSyms.includes(String(s)))) return true
    } catch {}
  }
  return false
}

// ---- AI 架构摘要 ----

// 从 .env 加载 LLM API 配置（OpenAI 兼容端点）
function loadLlmConfig() {
  const envPath = join(ROOT, '***REMOVED***/.env')
  try {
    const content = readFileSync(envPath, 'utf8')
    const cfg = {}
    for (const line of content.split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/)
      if (m) cfg[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
    return cfg
  } catch {
    return {}
  }
}

const LLM_CFG = loadLlmConfig()

/**
 * 调用 LLM API 为项目生成 AI 架构摘要。
 * 输入：项目 key、描述、各语言单元的符号概览和依赖。
 * 输出：2-3 段中文架构分析（核心流程、设计模式、技术栈）。
 */
async function generateAiSummary(projectKey, desc, units) {
  if (!LLM_CFG.OPENAI_API_KEY || !LLM_CFG.OPENAI_BASE_URL) {
    console.error('  [AI] 跳过：未配置 LLM API')
    return ''
  }
  // 构建上下文：各单元的文件+符号概览（截断避免超长）
  const contextParts = []
  for (const u of units) {
    if (u.lspStatus !== 'ok' || !u.files) continue
    const fileSummaries = u.files
      .slice(0, 8)
      .map((f) => {
        let syms = ''
        try {
          const obj = JSON.parse(f.symbols)
          syms = Object.entries(obj)
            .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.slice(0, 8).join(', ') : v}`)
            .join('; ')
        } catch {}
        return `- ${f.rel}${f.lineCount ? ` (${f.lineCount}行)` : ''}: ${syms}`
      })
      .join('\n')
    if (fileSummaries) {
      contextParts.push(`【${u.lang}】\n${fileSummaries}`)
    }
  }
  const context = contextParts.join('\n\n').slice(0, 4000)
  const prompt = `你是一位资深软件架构师。请根据以下项目信息，用中文写一段 200-300 字的架构摘要。

项目：${projectKey}
描述：${desc || '（无）'}

代码结构概览：
${context}

要求：
1. 概括核心架构和设计模式
2. 指出关键模块和它们的职责
3. 提到技术栈特点
4. 不要罗列文件清单，要有分析洞察
5. 直接输出摘要正文，不要标题或前缀`

  try {
    const res = await fetch(`${LLM_CFG.OPENAI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LLM_CFG.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: LLM_CFG.OPENAI_MODEL || 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 500,
      }),
    })
    if (!res.ok) {
      console.error(`  [AI] ${projectKey} API 错误: ${res.status}`)
      return ''
    }
    const data = await res.json()
    const summary = data.choices?.[0]?.message?.content?.trim() || ''
    console.error(`  [AI] ${projectKey} 摘要生成成功 (${summary.length}字)`)
    return summary
  } catch (e) {
    console.error(`  [AI] ${projectKey} 生成失败: ${e?.message || e}`)
    return ''
  }
}

// 用独立 serena 进程分析一个目录（按 exts 过滤抽样文件）。每个语言单元独立进程，
// 避免串行切换导致的 LSP 符号索引污染；混仓各语言互不干扰。
// 用独立 serena 进程分析一个目录（按 exts 过滤抽样文件）。每个语言单元独立进程，
// 避免串行切换导致的 LSP 符号索引污染；混仓各语言互不干扰。
//
// 关键防卡死设计：connect 与每个 MCP 调用都套 PROJECT_TIMEOUT 硬超时。一旦超时，
// finally 里先优雅关闭 transport，再 killTree 强杀 serena 进程树（含 LSP 孙进程），
// 并返回降级结果——单个语言单元的 LSP hang 绝不会再拖垮整轮扫描（此前 cicdkit 即因此卡死 2 小时）。
async function analyzeWithSerena(absDir, lang, exts) {
  const transport = new StdioClientTransport({
    command: UV,
    args: [
      'run',
      '--directory',
      SERENA_DIR,
      'serena',
      'start-mcp-server',
      '--context',
      'claude-code',
    ],
    stderr: 'pipe',
  })
  const client = new Client({ name: 'ws-scan', version: '1.0.0' })
  try {
    await withTimeout(
      client.connect(transport, { timeout: PROJECT_TIMEOUT }),
      PROJECT_TIMEOUT,
      'connect:' + absDir,
    )
    currentSerenaPid = transport.pid
    const a = await withTimeout(
      client.callTool({ name: 'activate_project', arguments: { project: absDir } }),
      PROJECT_TIMEOUT,
      'activate:' + absDir,
    )
    if (a.err) throw new Error('activate failed: ' + a.text.slice(0, 300))
    const sources = listSources(absDir, 400, exts)
    const sampled = sources.slice(0, MAX_FILES)
    const files = []
    let symbolCount = 0,
      diagCount = 0
    for (const abs of sampled) {
      const rel = relative(absDir, abs)
      const s = txt(
        await withTimeout(
          client.callTool({
            name: 'get_symbols_overview',
            arguments: { relative_path: rel, depth: 0, max_answer_chars: SYM_CHARS },
          }),
          PROJECT_TIMEOUT,
          'sym:' + rel,
        ),
      )
      const symbols = s.err ? '' : s.text
      symbolCount += countSymbols(symbols)
      let diagnostics = ''
      if (symbols) {
        const d = txt(
          await withTimeout(
            client.callTool({
              name: 'get_diagnostics_for_file',
              arguments: { relative_path: rel },
            }),
            PROJECT_TIMEOUT,
            'diag:' + rel,
          ),
        )
        if (!d.err && d.text.trim() && d.text.trim() !== '{}') {
          // Filter out environment-difference errors before storing
          // (serena's isolated LSP environments can't see project .venv/node_modules)
          const ENV_DIFF_CODES = new Set([
            'reportMissingImports',
            'reportMissingModuleSource',
            'reportFunctionMemberAccess',
            'reportIncompatibleMethodOverride',
            'reportTypedDictNotRequiredAccess',
            'reportUnsupportedDunderAll',
            '2304',
            '2307',
            '2322',
            '2339',
            '2345',
            '2451',
            '2580',
            '2875',
            '7026',
            '7043',
            '7044',
            '80005',
          ])
          try {
            const dj = JSON.parse(d.text)
            const filtered = {}
            let keptCount = 0
            for (const [k, v] of Object.entries(dj)) {
              if (!v || !Array.isArray(v.Error)) continue
              const kept = v.Error.filter((e) => !ENV_DIFF_CODES.has(String(e.code)))
              if (kept.length) {
                filtered[k] = { Error: kept }
                keptCount += kept.length
              }
            }
            diagnostics = Object.keys(filtered).length ? JSON.stringify(filtered) : ''
            diagCount += keptCount
          } catch {
            diagnostics = d.text.slice(0, DIAG_CHARS)
            diagCount += 1
          }
        }
      }
      let insights = { lineCount: 0, summaries: {}, imports: [], isTest: false }
      try {
        insights = extractFileInsights(abs, lang)
      } catch (e) {
        console.error('  ! extractFileInsights failed:', rel, e?.message)
      }
      let isCore = false
      try {
        isCore = isCoreEntry(rel, symbols)
      } catch (e) {
        console.error('  ! isCoreEntry failed:', rel, e?.message)
      }
      files.push({
        rel,
        symbols: symbols.slice(0, SYM_CHARS),
        diagnostics: diagnostics.slice(0, DIAG_CHARS),
        lineCount: insights.lineCount,
        summaries: insights.summaries,
        imports: insights.imports,
        isTest: insights.isTest,
        isCore,
      })
    }
    // 汇总代码质量指标
    const totalLines = files.reduce((n, f) => n + (f.lineCount || 0), 0)
    const testFiles = files.filter((f) => f.isTest).length
    const coreFiles = files.filter((f) => f.isCore).map((f) => f.rel)
    const allImports = [...new Set(files.flatMap((f) => f.imports || []))]
    return {
      fileCount: sources.length,
      symbolCount,
      diagCount,
      files,
      lspStatus: 'ok',
      totalLines,
      testFiles,
      coreFiles,
      dependencies: allImports,
    }
  } catch (e) {
    const msg = e?.message || String(e)
    console.error('  !', absDir, 'LSP 分析超时/失败 → 降级:', msg.slice(0, 120))
    return {
      fileCount: 0,
      symbolCount: 0,
      diagCount: 0,
      files: [],
      lspStatus: 'timeout',
      error: 'LSP 分析超时或被中止：' + msg.slice(0, 200),
    }
  } finally {
    currentSerenaPid = null
    const pid = transport.pid
    try {
      await withTimeout(client.close(), 5000, 'close')
    } catch {}
    if (pid) killTree(pid)
  }
}

// Markdown 轻量分析：提取标题层级、frontmatter 字段、内部链接
// 返回与 analyzeWithSerena 相同的数据结构，以便复用渲染逻辑
async function analyzeMarkdown(absDir, exts) {
  const sources = listSources(absDir, 400, exts)
  const sampled = sources.slice(0, MAX_FILES)
  const files = []
  let symbolCount = 0

  for (const abs of sampled) {
    const rel = relative(absDir, abs)
    let content = ''
    try {
      content = readFileSync(abs, 'utf8')
    } catch {
      files.push({ rel, symbols: '', diagnostics: '' })
      continue
    }

    const symbols = {}

    // 提取 frontmatter（YAML 格式，位于文件开头 --- 之间）
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
    if (fmMatch) {
      const fm = fmMatch[1]
      // 提取常见 frontmatter 字段
      const titleMatch = fm.match(/^title:\s*(.+)$/m)
      const descMatch = fm.match(/^description:\s*(.+)$/m)
      const tagsMatch = fm.match(/^tags:\s*\[([^\]]*)\]/m)
      const dateMatch = fm.match(/^date:\s*(.+)$/m)

      if (titleMatch) symbols['标题 Title'] = [titleMatch[1].trim().replace(/^["']|["']$/g, '')]
      if (descMatch)
        symbols['描述 Description'] = [
          descMatch[1]
            .trim()
            .replace(/^["']|["']$/g, '')
            .slice(0, 80),
        ]
      if (tagsMatch) {
        const tags = tagsMatch[1]
          .split(',')
          .map((t) => t.trim().replace(/^["']|["']$/g, ''))
          .filter(Boolean)
        if (tags.length) symbols['标签 Tags'] = tags
      }
      if (dateMatch) symbols['日期 Date'] = [dateMatch[1].trim()]
    }

    // 提取标题（H1-H4）
    const headings = []
    const headingRegex = /^(#{1,4})\s+(.+)$/gm
    let m
    while ((m = headingRegex.exec(content)) !== null) {
      const level = m[1].length
      const text = m[2].trim()
      const prefix = ['', 'H1', 'H2', 'H3', 'H4'][level]
      if (!symbols[prefix]) symbols[prefix] = []
      symbols[prefix].push(text)
      headings.push(text)
    }

    // 提取内部链接（相对路径的 .md 链接）
    const internalLinks = []
    const linkRegex = /\[([^\]]*)\]\(([^)]+\.md[^)]*)\)/g
    while ((m = linkRegex.exec(content)) !== null) {
      const linkText = m[1].trim()
      const linkPath = m[2].trim()
      if (linkText && linkPath) {
        internalLinks.push(linkText)
      }
    }
    if (internalLinks.length) symbols['链接 Links'] = internalLinks.slice(0, 20) // 限制数量

    // 计算符号数
    const symCount = Object.values(symbols).reduce((n, arr) => n + arr.length, 0)
    symbolCount += symCount

    // 序列化为 JSON 字符串（与 serena 格式一致）
    const symbolsJson = Object.keys(symbols).length ? JSON.stringify(symbols) : ''
    files.push({ rel, symbols: symbolsJson.slice(0, SYM_CHARS), diagnostics: '' })
  }

  return { fileCount: sources.length, symbolCount, diagCount: 0, files, lspStatus: 'ok' }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error('timeout ' + ms + 'ms (' + label + ')')), ms),
    ),
  ])
}

// 杀掉一个 pid 及其所有子孙进程。serena 会 spawn LSP 孙进程（gopls/rust-analyzer/jdtls），
// 仅 kill 父进程会留下 LSP 孤儿继续占用端口/CPU，必须把整棵进程树递归清理掉。
function killTree(pid) {
  if (!pid) return
  try {
    const kids = execSync(`pgrep -P ${pid}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean)
    for (const k of kids) {
      try {
        killTree(parseInt(k, 10))
      } catch {}
    }
  } catch {}
  try {
    process.kill(pid, 'SIGKILL')
  } catch {}
}

// ---- workspace UI 集成：进度文件 + 结构化 JSON ----
// 这些产物供 agent-harness web UI（/api/workspace*）消费，实现「项目情况展示 + 重新检测进度」。
const STATUS_FILE = OUT_DIR + '/.scan-status.json'
const PROJECTS_JSON = OUT_DIR + '/projects.json'
const FULL_JSON = OUT_DIR + '/projects-full.json'
function writeStatus(o) {
  try {
    writeFileSync(STATUS_FILE, JSON.stringify(o, null, 2))
  } catch (e) {
    console.error('[status] write failed:', e?.message || e)
  }
}
// 把单项目结果压成 UI 卡片所需的精简摘要（不含大段符号/诊断原文）
function slimProject(r) {
  return {
    key: r.key,
    repo: r.repo,
    github: r.github,
    article: r.article,
    sourceDir: r.sourceDir,
    desc: r.desc,
    highlights: r.highlights,
    status: r.status,
    lspStatus: r.lspStatus,
    cached: r.cached || false,
    mixed: r.mixed || false,
    languages: r.languages || (r.lang ? [r.lang] : []),
    symbolCount: r.symbolCount || 0,
    diagCount: r.diagCount || 0,
    fileCount: r.fileCount || 0,
    note: r.note || '',
    units: (r.units || []).map((u) => ({
      lang: u.lang,
      dir: relative(ROOT, u.dir),
      lspStatus: u.lspStatus,
      symbolCount: u.symbolCount || 0,
      diagCount: u.diagCount || 0,
      fileCount: u.fileCount || 0,
      error: u.error || '',
    })),
  }
}

// 增量持久化：每分析完一个项目就把【完整条目】并入磁盘（projects-full.json），
// 并据此重算精简 JSON（projects.json）与完整报告（index.html）。
// 这样即使进程被 OOM / 异常杀死，已完成的项目也已落盘，不会整体丢失。
function loadExistingFull() {
  try {
    const raw = readFileSync(FULL_JSON, 'utf8')
    const d = JSON.parse(raw)
    return Array.isArray(d) ? d : d.projects || []
  } catch {
    return []
  }
}
function persistFull(results) {
  const byKey = new Map(loadExistingFull().map((e) => [e.key, e]))
  for (const r of results) byKey.set(r.key, r) // 本轮已分析的覆盖旧值
  const merged = [...byKey.values()]
  try {
    writeFileSync(
      FULL_JSON,
      JSON.stringify({ generatedAt: new Date().toISOString(), projects: merged }, null, 2),
    )
    writeFileSync(
      PROJECTS_JSON,
      JSON.stringify(
        { generatedAt: new Date().toISOString(), projects: merged.map(slimProject) },
        null,
        2,
      ),
    )
    writeFileSync(join(OUT_DIR, 'index.html'), renderHtml(merged))
  } catch (e) {
    console.error('[persist] write failed:', e?.message || e)
  }
}

// ---- 主流程 ----
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
let projects = Object.entries(manifest).map(([key, v]) => ({ key, ...v }))

const SCAN_ONLY = process.env.SCAN_ONLY
if (SCAN_ONLY) {
  const keep = new Set(
    SCAN_ONLY.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  projects = projects.filter((p) => keep.has(p.key))
  console.error('SCAN_ONLY =', [...keep].join(', '), '→', projects.length, '个项目')
}

// 排序：与工作区页面一致 — 混仓在前，功能按钮多的在前
const PROJECT_RANK = {
  'autogen-pse': { multi: true, actions: 2 },
  'autogen-pse-architecture': { multi: true, actions: 2 },
  'langgraph-pse': { multi: false, actions: 4 },
  'crewai-pse': { multi: false, actions: 1 },
  'llamaindex-pse': { multi: false, actions: 1 },
}
projects.sort((a, b) => {
  const ra = PROJECT_RANK[a.key] || { multi: false, actions: 0 }
  const rb = PROJECT_RANK[b.key] || { multi: false, actions: 0 }
  if (ra.multi !== rb.multi) return rb.multi ? 1 : -1
  return rb.actions - ra.actions
})

console.error(
  'LSP 可用性：rust-analyzer=%s gopls=%s jdtls=%s',
  hasBin('rust-analyzer') ? 'yes' : 'no',
  hasBin('gopls') ? 'yes' : 'no',
  hasBin('jdtls') ? 'yes' : 'no',
)

mkdirSync(OUT_DIR, { recursive: true })

// 缓存：从上一轮 projects-full.json 载入已完成条目；对尚无签名（旧版产出的）条目
// 按当前源码指纹补种签名，使「代码未变则跳过」在本轮即可生效，不必等下一轮。
const FORCE = process.env.FORCE === '1'
const baseline = loadExistingFull()
const baselineByKey = new Map()
for (const e of baseline) {
  if (e.signature == null) e.signature = projectSignature(join(ROOT, e.sourceDir))
  baselineByKey.set(e.key, e)
}

const results = []
let skipped = 0
const startedAt = new Date().toISOString()
// 初始进度：扫描开始，尚未处理任何项目
writeStatus({
  status: 'running',
  startedAt,
  pid: process.pid,
  total: projects.length,
  current: 0,
  currentKey: '',
  processed: [],
  skipped: 0,
  force: FORCE,
})
// 符号概览类别：中文名 + 展示顺序 + 配色类型（必须定义在主循环之前，
// 否则 renderSymbols 在循环内首次调用时会触发 TDZ 报错）。

// 符号概览类别：中文名 + 展示顺序 + 配色类型（必须定义在主循环之前，
// 否则 renderSymbols 在循环内首次调用时会触发 TDZ 报错）。
const SYM_CAT_CN = {
  Function: '函数',
  Method: '方法',
  Struct: '结构体',
  Class: '类',
  Object: '对象',
  Interface: '接口',
  Trait: '特质',
  Enum: '枚举',
  Constant: '常量',
  Module: '模块',
  // Markdown 类别
  H1: '一级标题',
  H2: '二级标题',
  H3: '三级标题',
  H4: '四级标题',
  '标题 Title': '标题',
  '描述 Description': '描述',
  '标签 Tags': '标签',
  '日期 Date': '日期',
  '链接 Links': '链接',
}
const SYM_CAT_ORDER = [
  'Function',
  'Method',
  'Struct',
  'Class',
  'Object',
  'Interface',
  'Trait',
  'Enum',
  'Constant',
  'Module',
  'H1',
  'H2',
  'H3',
  'H4',
  '标题 Title',
  '描述 Description',
  '标签 Tags',
  '日期 Date',
  '链接 Links',
]
function symCatType(k) {
  if (k === 'Function' || k === 'Method') return 'fn'
  if (k === 'Struct' || k === 'Class' || k === 'Object') return 'st'
  if (k === 'Interface' || k === 'Trait') return 'if'
  if (k === 'Enum') return 'ty'
  if (k === 'Constant') return 'co'
  if (k === 'Module') return 'md'
  // Markdown 类别使用 md 类型（灰色）
  if (
    k.startsWith('H') ||
    k.includes('Title') ||
    k.includes('Description') ||
    k.includes('Tags') ||
    k.includes('Date') ||
    k.includes('Links')
  )
    return 'md'
  return 'md'
}

for (const p of projects) {
  if (aborted) break
  const absDir = join(ROOT, p.source_dir)
  const currentSig = projectSignature(absDir)
  // 跳过逻辑：上一轮已分析过、且源码指纹未变 → 直接复用缓存结果，不再跑 LSP。
  // （FORCE=1 时强制全部重跑；missing/no-lsp 等廉价分支仍会走，但不消耗 LSP。）
  const base = baselineByKey.get(p.key)
  if (
    !FORCE &&
    isReusable(base) &&
    (currentSig === null ? base.signature == null : base.signature === currentSig)
  ) {
    results.push({ ...base, cached: true })
    skipped++
    writeStatus({
      status: 'running',
      startedAt,
      pid: process.pid,
      total: projects.length,
      current: results.length,
      currentKey: p.key,
      processed: results.map((r) => r.key),
      skipped,
      note: '缓存命中·跳过',
    })
    persistFull(results)
    continue
  }
  // 进度更新：本轮正在分析 p.key
  writeStatus({
    status: 'running',
    startedAt,
    pid: process.pid,
    total: projects.length,
    current: results.length + 1,
    currentKey: p.key,
    processed: results.map((r) => r.key),
    skipped,
  })
  const entry = {
    key: p.key,
    repo: p.repo,
    desc: p.desc || '',
    highlights: p.highlights || '',
    github: 'https://github.com/' + p.repo,
    article: p.published || {},
    sourceDir: p.source_dir,
    signature: currentSig,
  }
  if (!existsSync(absDir)) {
    entry.status = 'missing'
    entry.error = '源目录不存在：' + p.source_dir
    console.error('✗', p.key, '(missing)')
  } else {
    const units = detectUnits(absDir)
    if (units.length === 0) {
      // 无构建文件：检查是否有 Markdown 文件（纯文档项目如 agentic-souls）
      const mdFiles = listSources(absDir, 200, ['.md'])
      if (mdFiles.length > 0) {
        units.push({ lang: 'Markdown', dir: absDir })
      }
    }
    if (units.length === 0) {
      // 无构建文件（纯文档/脚本项目）：仅列文件结构，不跑 LSP
      entry.status = 'no-code'
      entry.lang = 'unknown'
      entry.fileList = listSources(absDir, 200).map((f) => relative(absDir, f))
      entry.lspStatus = 'no-lsp-needed'
      console.error('·', p.key, '(无构建文件, 仅列结构)')
    } else {
      entry.status = 'ok'
      entry.mixed = units.length > 1
      const unitResults = []
      for (const u of units) {
        if (aborted) break // SIGTERM 后不再为后续语言单元起新的 serena，避免遗留孤儿
        if (!lspAvailable(u.lang)) {
          // Markdown 无 LSP，但可以做轻量分析（提取标题/frontmatter/链接）
          if (u.lang === 'Markdown') {
            try {
              console.error('→', p.key, '/', u.lang, '(', relative(ROOT, u.dir), ') [轻量分析]')
              const r = await analyzeMarkdown(u.dir, LANG_EXT[u.lang])
              unitResults.push({ lang: u.lang, dir: u.dir, ...r })
            } catch (e) {
              unitResults.push({
                lang: u.lang,
                dir: u.dir,
                lspStatus: 'error',
                error: 'Markdown 分析失败：' + String(e?.message || e),
                fileList: listSources(u.dir, 200, LANG_EXT[u.lang]).map((f) => relative(u.dir, f)),
              })
              console.error('', p.key, '/', u.lang, String(e?.message || e))
            }
            continue
          }
          const errorMsg = u.lang + ' 的 LSP 未安装（rust-analyzer / gopls / jdtls），仅列文件结构'
          unitResults.push({
            lang: u.lang,
            dir: u.dir,
            lspStatus: 'lsp-missing',
            error: errorMsg,
            fileList: listSources(u.dir, 200, LANG_EXT[u.lang]).map((f) => relative(u.dir, f)),
          })
          console.error('·', p.key, '/', u.lang, '(LSP 缺失, 仅列结构)')
          continue
        }
        try {
          console.error('→', p.key, '/', u.lang, '(', relative(ROOT, u.dir), ')')
          const r = await withTimeout(
            analyzeWithSerena(u.dir, u.lang, LANG_EXT[u.lang]),
            PROJECT_TIMEOUT,
            p.key + '/' + u.lang,
          )
          unitResults.push({ lang: u.lang, dir: u.dir, ...r })
        } catch (e) {
          unitResults.push({
            lang: u.lang,
            dir: u.dir,
            lspStatus: 'error',
            error: '分析失败：' + String(e?.message || e),
            fileList: listSources(u.dir, 200, LANG_EXT[u.lang]).map((f) => relative(u.dir, f)),
          })
          console.error('✗', p.key, '/', u.lang, String(e?.message || e))
        }
      }
      entry.units = unitResults
      entry.languages = unitResults.map((u) => u.lang)
      const okUnits = unitResults.filter((u) => u.lspStatus === 'ok')
      const missUnits = unitResults.filter((u) => u.lspStatus === 'lsp-missing')
      const errUnits = unitResults.filter((u) => u.lspStatus === 'error')
      entry.lspStatus = okUnits.length ? 'ok' : missUnits.length ? 'lsp-missing' : 'error'
      entry.fileCount = unitResults.reduce(
        (n, u) => n + (u.fileCount ?? (u.fileList ? u.fileList.length : 0)),
        0,
      )
      entry.symbolCount = unitResults.reduce((n, u) => n + (u.symbolCount ?? 0), 0)
      entry.diagCount = unitResults.reduce((n, u) => n + (u.diagCount ?? 0), 0)
      entry.note = entry.mixed
        ? '混仓：按语言分别激活 LSP'
        : errUnits.length
          ? '部分语言分析失败'
          : ''
    }
  }
  // 中断保护：若已收到 SIGTERM，已落盘的结果保留，不追加当前（可能半截）项目。
  if (aborted) {
    persistFull(results)
    break
  }
  // AI 架构摘要：对新分析的项目（非缓存）生成摘要
  if (entry.lspStatus === 'ok' && entry.units && !entry.aiSummary) {
    console.error(`  [AI] 正在生成 ${p.key} 架构摘要…`)
    entry.aiSummary = await generateAiSummary(p.key, entry.desc, entry.units)
  }
  results.push(entry)
  // 增量持久化：每完成一个项目就落盘（projects-full.json / projects.json / index.html），
  // 即使后续进程被 OOM 杀死，已完成项目也已保存，不会整体丢失。
  persistFull(results)
}

// ---- 渲染 ----
function esc(s) {
  return (s == null ? '' : String(s))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// 渲染诊断块：仅当存在【Error】级诊断时才显示（空对象 {} 与仅有 Warning 的均隐藏）。
// 展示时只保留 Error 条目、过滤掉 Warning——Warning 在概览报告里属于噪音。
// 符号概览原始是 serena 返回的单行 JSON（如 {"Function":[...],"Struct":[...]}）。
// 原样塞进 <pre> 会一行挤死、难读。这里解析后按类别分组，渲染成
// 「中文类别(英文key) + 可换行标签」的结构化视图，比纯文本清晰得多。
function renderSymbols(raw, summaries = {}) {
  if (!raw || !raw.trim()) return '<p class="muted">无符号概览</p>'
  let obj
  try {
    obj = JSON.parse(raw)
  } catch {
    return `<pre class="sym-raw">${esc(raw)}</pre>`
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj))
    return `<pre class="sym-raw">${esc(raw)}</pre>`
  const keys = Object.keys(obj).sort((a, b) => {
    let ia = SYM_CAT_ORDER.indexOf(a)
    let ib = SYM_CAT_ORDER.indexOf(b)
    if (ia < 0) ia = 999
    if (ib < 0) ib = 999
    return ia - ib
  })
  const groups = keys
    .map((k) => {
      const items = Array.isArray(obj[k]) ? obj[k] : [obj[k]]
      if (!items || !items.length) return ''
      const cn = SYM_CAT_CN[k] || k
      const t = symCatType(k)
      const chips = items
        .map((it) => {
          const name = String(it)
          const summary = summaries[name]
          if (summary) {
            return `<span class="sym-chip" title="${esc(summary)}">${esc(name)}<span class="sym-summary"> — ${esc(summary)}</span></span>`
          }
          return `<span class="sym-chip">${esc(name)}</span>`
        })
        .join('')
      return `<div class="sym-group"><span class="sym-cat sym-cat-${t}">${esc(cn)}<span class="sym-cat-en">${esc(k)}</span></span>${chips}</div>`
    })
    .filter(Boolean)
    .join('')
  return `<div class="sym">${groups}</div>`
}

// 符号概览原始是 serena 返回的单行 JSON（如 {"Function":[...],"Struct":[...]}）。
// 原样塞进 <pre> 会一行挤死、难读。这里解析后按类别分组，渲染成
// 「中文类别(英文key) + 可换行标签」的结构化视图，比纯文本清晰得多。

function renderDiag(raw) {
  const t = (raw || '').trim()
  if (!t || t === '{}') return ''
  let parsed
  try {
    parsed = JSON.parse(t)
  } catch {
    return `<pre class="diag">${esc(raw)}</pre>`
  }

  // Filter out environment-difference errors that are not actionable in this report context:
  // - Python (pyright): reportMissingImports, reportMissingModuleSource, reportFunctionMemberAccess,
  //   reportIncompatibleMethodOverride, reportTypedDictNotRequiredAccess, reportUnsupportedDunderAll
  //   (serena's uv-isolated pyright can't see project .venv packages)
  // - TypeScript: 2304 (Cannot find name), 2307 (Cannot find module), 2322 (Type not assignable),
  //   2339 (Property does not exist), 2345 (Argument type mismatch), 2451 (Cannot find variable),
  //   2580 (Cannot find name 'process'), 2875 (JSX element type), 7026 (JSX implicit any),
  //   7043/7044 (Type parameter issues), 80005 (Missing type declaration)
  //   (serena's tsserver runs in isolated ls_resources_dir, no ATA, no project node_modules)
  const ENV_DIFF_CODES = new Set([
    'reportMissingImports',
    'reportMissingModuleSource',
    'reportFunctionMemberAccess',
    'reportIncompatibleMethodOverride',
    'reportTypedDictNotRequiredAccess',
    'reportUnsupportedDunderAll',
    '2304',
    '2307',
    '2322',
    '2339',
    '2345',
    '2451',
    '2580',
    '2875',
    '7026',
    '7043',
    '7044',
    '80005',
  ])

  let hasError = false
  for (const v of Object.values(parsed)) {
    if (v && Array.isArray(v.Error) && v.Error.length) {
      hasError = true
      break
    }
  }
  if (!hasError) return ''

  const filtered = {}
  for (const [k, v] of Object.entries(parsed)) {
    if (!v || !Array.isArray(v.Error) || !v.Error.length) continue
    const kept = v.Error.filter((e) => {
      const code = String(e.code)
      return !ENV_DIFF_CODES.has(code)
    })
    if (kept.length) filtered[k] = { Error: kept }
  }

  // If all errors were filtered out, render nothing
  if (!Object.keys(filtered).length) return ''
  return `<pre class="diag">${esc(JSON.stringify(filtered, null, 2))}</pre>`
}

// 由【完整条目数组】渲染完整 HTML 报告（可从磁盘合并后的全量数据重渲染）。
function renderHtml(projects) {
  const analyzed = projects.filter((r) => r.lspStatus === 'ok').length
  const lspMissing = projects.filter((r) => r.lspStatus === 'lsp-missing').length
  const noCode = projects.filter(
    (r) => r.lspStatus === 'no-lsp-needed' || r.status === 'missing',
  ).length
  const mixed = projects.filter((r) => r.mixed).length

  function cardStat(r) {
    if (r.status === 'missing') return '源目录缺失'
    if (r.units) {
      if (r.lspStatus === 'ok')
        return `${r.languages.join('/')} · ${r.symbolCount} 符号 · ${r.diagCount} 诊断`
      if (r.lspStatus === 'lsp-missing') return `${r.languages.join('/')} · LSP 未安装·仅结构`
      return `${r.languages.join('/')} · 部分失败`
    }
    if (r.lspStatus === 'no-lsp-needed') return '无构建文件·仅元数据'
    return r.error || '无源码'
  }

  function projectCard(r) {
    const links = []
    links.push(`<a class="gh" href="${esc(r.github)}" target="_blank" rel="noopener">GitHub</a>`)
    if (r.article?.zh)
      links.push(
        `<a class="art" href="${esc(r.article.zh.link)}" target="_blank" rel="noopener">文章·中</a>`,
      )
    if (r.article?.en)
      links.push(
        `<a class="art" href="${esc(r.article.en.link)}" target="_blank" rel="noopener">文章·英</a>`,
      )
    const lang = r.languages ? r.languages.join('/') : r.lang || '?'
    return `<div class="pcard">
    <div class="phead"><span class="pname">${esc(r.key)}</span><span class="plang">${esc(lang)}</span></div>
    <div class="plinks">${links.join('')}<button class="rescan-btn" data-key="${esc(r.key)}" onclick="rescanProject('${esc(r.key)}', this)">重新扫描</button></div>
    <div class="pstat">${esc(cardStat(r))}</div>
  </div>`
  }

  function renderUnit(r, u) {
    const relDir = relative(ROOT, u.dir)
    const head = `<h3 class="ulang">${esc(u.lang)} <span class="upath">${esc(relDir)}</span></h3>`
    if (u.lspStatus === 'ok') {
      // 核心文件置顶
      const sortedFiles = [...u.files].sort((a, b) => {
        if (a.isCore && !b.isCore) return -1
        if (!a.isCore && b.isCore) return 1
        return 0
      })
      const files = sortedFiles
        .map(
          (f) => {
            const coreBadge = f.isCore ? '<span class="core-badge">核心</span>' : ''
            const testBadge = f.isTest ? '<span class="test-badge">测试</span>' : ''
            const lineBadge = f.lineCount ? `<span class="line-badge">${f.lineCount}行</span>` : ''
            const badges = [coreBadge, testBadge, lineBadge].filter(Boolean).join('')
            return `<div class="file${f.isCore ? ' file-core' : ''}"><h4>${esc(f.rel)} ${badges}</h4>${f.symbols ? renderSymbols(f.symbols, f.summaries || {}) : '<div class="sym"><span class="sym-cat sym-cat-md">无符号<span class="sym-cat-en">NoSymbols</span></span></div>'}${renderDiag(f.diagnostics)}</div>`
          },
        )
        .join('')
      // 代码质量指标
      const totalLines = u.totalLines || u.files.reduce((n, f) => n + (f.lineCount || 0), 0)
      const testCount = u.testFiles ?? u.files.filter((f) => f.isTest).length
      const avgLines = u.files.length ? Math.round(totalLines / u.files.length) : 0
      const qualityStats = `<div class="quality-bar">📊 抽样代码 ${totalLines} 行 · 平均 ${avgLines} 行/文件 · 测试文件 ${testCount}/${u.files.length}</div>`
      // 模块依赖
      const deps = u.dependencies || [...new Set(u.files.flatMap((f) => f.imports || []))]
      const depHtml = deps.length
        ? `<div class="deps-bar"><span class="deps-label">依赖：</span>${deps.slice(0, 20).map((d) => `<span class="dep-chip">${esc(d)}</span>`).join('')}${deps.length > 20 ? `<span class="dep-more">+${deps.length - 20}</span>` : ''}</div>`
        : ''
      return `<div class="unit">${head}<p class="stat">抽样 ${Math.min(MAX_FILES, u.fileCount)} / 共 ${u.fileCount} 个源文件 · ${u.symbolCount} 顶层符号 · ${u.diagCount} 诊断项</p>${qualityStats}${depHtml}${files}</div>`
    }
    if (u.fileList && u.fileList.length) {
      const tree = u.fileList
        .slice(0, 60)
        .map((f) => `<li>${esc(f)}</li>`)
        .join('')
      return `<div class="unit">${head}<p class="warn">${esc(u.error || 'LSP 未安装·仅列结构')}</p><p class="stat">本地源文件 ${u.fileList.length} 个（列出前 ${Math.min(60, u.fileList.length)}）：</p><ul class="ftree">${tree}</ul></div>`
    }
    return `<div class="unit">${head}<p class="warn">${esc(u.error || '无源码可分析')}</p></div>`
  }

  function projectSection(r) {
    const links = []
    links.push(
      `<a class="gh" href="${esc(r.github)}" target="_blank" rel="noopener">GitHub 仓库 ↗</a>`,
    )
    if (r.article?.zh)
      links.push(
        `<a class="art" href="${esc(r.article.zh.link)}" target="_blank" rel="noopener">技术文章（中）↗</a>`,
      )
    if (r.article?.en)
      links.push(
        `<a class="art" href="${esc(r.article.en.link)}" target="_blank" rel="noopener">技术文章（英）↗</a>`,
      )
    let body = ''
    if (r.units && r.units.length) {
      body = r.units.map((u) => renderUnit(r, u)).join('')
    } else if (r.fileList && r.fileList.length) {
      const tree = r.fileList
        .slice(0, 60)
        .map((f) => `<li>${esc(f)}</li>`)
        .join('')
      body = `<p class="warn">${esc(r.error || '无构建文件')}</p><p class="stat">本地源文件 ${r.fileList.length} 个（列出前 ${Math.min(60, r.fileList.length)}）：</p><ul class="ftree">${tree}</ul>`
    } else if (r.status === 'missing') {
      body = `<p class="warn">源目录不存在：${esc(r.sourceDir)}</p>`
    } else {
      body = `<p class="warn">${esc(r.error || '无源码可分析')}</p>`
    }
    const lang = r.languages ? r.languages.join('/') : r.lang || '?'
    const fileCount = r.units
      ? r.units.reduce((n, u) => n + (u.fileCount ?? 0), 0)
      : r.fileList?.length ?? 0
    const symbolCount = r.symbolCount ?? (r.units ? r.units.reduce((n, u) => n + (u.symbolCount ?? 0), 0) : 0)
    const diagCount = r.diagCount ?? (r.units ? r.units.reduce((n, u) => n + (u.diagCount ?? 0), 0) : 0)
    return `<section id="${esc(r.key)}">
    <div class="shead"><h2>${esc(r.key)} <span class="plang">${esc(lang)}</span></h2><div class="slinks">${links.join('')}</div></div>
    <p class="path">${esc(r.sourceDir)}</p>
    <p class="desc">${esc(r.desc)}</p>
    <p class="hl"><b>亮点：</b>${esc(r.highlights)}</p>
    ${r.aiSummary ? `<div class="ai-summary"><div class="ai-summary-title">🤖 AI 架构摘要</div><div class="ai-summary-body">${esc(r.aiSummary).replace(/\n/g, '<br>')}</div></div>` : ''}
    ${r.note ? `<p class="note">${esc(r.note)}</p>` : ''}
    <details class="code-details">
      <summary>📂 代码详情（${fileCount} 文件 · ${symbolCount} 符号 · ${diagCount} 诊断）</summary>
      ${body}
    </details>
  </section>`
  }

  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>resolve-studio · 工作区代码分析</title><style>
  :root{color-scheme:light;--bg:#f7f8fa;--card:#fff;--ink:#1f2328;--muted:#6b7280;--line:#e5e7eb;--accent:#2563eb;--diag:#991b1b;--warn:#92400e}
  *{box-sizing:border-box} html{background:#ffffff!important} body{margin:0 auto;max-width:1140px;font:15px/1.75 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:var(--bg)!important;color:var(--ink)!important;padding:32px 20px}
  h1{font-size:22px;margin:0 0 4px} .meta{color:var(--muted);margin:0 0 8px}
  .legend{display:flex;gap:18px;flex-wrap:wrap;color:var(--muted);font-size:12px;margin-bottom:24px}
  .legend b{color:var(--ink)}
  .summary{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin-bottom:28px}
  .pcard{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
  .phead{display:flex;justify-content:space-between;align-items:center;gap:8px}
  .pname{font-weight:600;font-size:14px}.plang{color:var(--accent);font-size:11px;background:#eff6ff;border-radius:5px;padding:1px 7px;white-space:nowrap}
  .plinks{margin:8px 0 4px;display:flex;gap:8px;flex-wrap:wrap}
  .pstat{color:var(--muted);font-size:13px}
  a.gh,a.art{font-size:12px;text-decoration:none;padding:2px 8px;border-radius:6px}
  a.gh{background:var(--ink);color:#fff}a.art{background:#eff6ff;color:var(--accent);border:1px solid #dbeafe}
  section{border-top:1px solid var(--line);padding:24px 0 24px 24px}
  .shead{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}
  h2{font-size:18px;margin:0} .slinks{display:flex;gap:10px;flex-wrap:wrap}
  .path{color:var(--muted);font-family:ui-monospace,monospace;font-size:13px;margin:4px 0;word-break:break-word}
  .desc{margin:8px 0 4px}.hl{color:#374151;font-size:13px;margin:4px 0 12px}
  .note{color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:4px 10px;font-size:12px;display:inline-block;margin:0 0 12px}
  .code-details{margin-top:12px;border:1px solid var(--line);border-radius:8px;background:var(--card);overflow:hidden}
  .code-details>summary{cursor:pointer;padding:10px 14px;font-weight:600;font-size:14px;color:var(--ink);background:#f9fafb;list-style:none;user-select:none}
  .code-details>summary::-webkit-details-marker{display:none}
  .code-details>summary::before{content:'▶';display:inline-block;margin-right:8px;font-size:10px;color:var(--muted);transition:transform .15s}
  .code-details[open]>summary::before{transform:rotate(90deg)}
  .code-details>summary:hover{background:#f3f4f6}
  .code-details[open]>summary{border-bottom:1px solid var(--line)}
  .unit{border:1px solid var(--line);border-radius:8px;margin:12px 0;padding:0 0 8px;overflow:hidden}
  .ulang{font-size:14px;margin:0;padding:7px 12px;background:#f0f2f5;font-family:ui-monospace,monospace}
  .ulang .upath{color:var(--muted);font-weight:400;font-size:11px;margin-left:6px}
  .stat{color:var(--muted);font-size:13px;margin:8px 14px}
  .file{border-top:1px solid var(--line);margin:0}
  .file h4{margin:0;padding:8px 14px;background:#fafbfc;font-size:13px;font-family:ui-monospace,monospace}
  pre{margin:0;padding:12px 14px;font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:360px;overflow:auto}
  pre.diag{background:#fef2f2;color:var(--diag);border-top:1px solid #fecaca}
  .sym{display:flex;flex-direction:column;gap:9px;padding:12px 14px}
  .sym p{margin:0}
  .sym .muted{padding-left:0}
  pre.sym-raw{background:#fbfcfe}
  .sym-group{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
  .sym-cat{display:inline-flex;align-items:baseline;gap:5px;font-size:12px;font-weight:600;padding:1px 9px;border-radius:11px;border:1px solid var(--line);background:#eef2f7;color:#475569}
  .sym-cat-en{font-weight:400;font-size:10.5px;opacity:.62;margin-left:2px}
  .sym-chip{font-family:ui-monospace,monospace;font-size:12px;line-height:1.5;padding:2px 8px;border-radius:6px;background:#fff;border:1px solid var(--line);color:var(--ink)}
  .sym-cat-fn{background:#e8f0fe;color:#1e40af;border-color:#c7d8fb}
  .sym-cat-st{background:#e7f6ec;color:#137a3b;border-color:#bfe6cc}
  .sym-cat-if{background:#f3e8ff;color:#6b21a8;border-color:#e3d0fb}
  .sym-cat-ty{background:#fff4e5;color:#92400e;border-color:#fde0b8}
  .sym-cat-co{background:#fdeaea;color:#991b1b;border-color:#f7c9c9}
  .sym-cat-md{background:#eef2f7;color:#475569;border-color:#dbe3ec}
  .warn{color:var(--warn)} .muted{color:var(--muted)}
  ul.ftree{columns:2;column-gap:24px;font-family:ui-monospace,monospace;font-size:13px;color:#374151;margin:6px 14px;padding-left:18px}
  ul.ftree li{break-inside:avoid;margin:1px 0}
  .rescan-btn{font-size:11px;padding:2px 8px;border-radius:6px;background:#eff6ff;color:var(--accent);border:1px solid #dbeafe;cursor:pointer;margin-left:6px}
  .rescan-btn:hover{background:#dbeafe}
  .rescan-btn:disabled{opacity:0.5;cursor:not-allowed}
  .rescan-btn.scanning{background:#fef3c7;color:#92400e;border-color:#fde68a}
  /* 符号摘要 */
  .sym-summary{color:var(--muted);font-size:11px;font-family:-apple-system,sans-serif;margin-left:4px}
  /* 文件徽章 */
  .core-badge{background:#dbeafe;color:#1e40af;font-size:10px;padding:1px 6px;border-radius:4px;font-weight:600;margin-left:6px}
  .test-badge{background:#dcfce7;color:#166534;font-size:10px;padding:1px 6px;border-radius:4px;font-weight:600;margin-left:6px}
  .line-badge{background:#f3f4f6;color:#6b7280;font-size:10px;padding:1px 6px;border-radius:4px;margin-left:6px;font-family:ui-monospace,monospace}
  .file-core{border-left:3px solid #2563eb}
  /* 代码质量条 */
  .quality-bar{margin:8px 14px;padding:6px 10px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;font-size:12px;color:#166534}
  /* 依赖条 */
  .deps-bar{margin:0 14px 8px;padding:6px 10px;background:#f8fafc;border:1px solid var(--line);border-radius:6px;font-size:11px;display:flex;flex-wrap:wrap;align-items:center;gap:4px}
  .deps-label{color:var(--muted);font-weight:600;margin-right:4px}
  .dep-chip{background:#fff;border:1px solid var(--line);padding:1px 7px;border-radius:4px;font-family:ui-monospace,monospace;color:#475569}
  .dep-more{color:var(--muted);font-size:10px}
  /* AI 架构摘要 */
  .ai-summary{margin:8px 0 12px;padding:12px 16px;background:linear-gradient(135deg,#eff6ff,#f5f3ff);border:1px solid #c7d2fe;border-radius:8px}
  .ai-summary-title{font-weight:600;font-size:13px;color:#4338ca;margin-bottom:6px}
  .ai-summary-body{font-size:13px;line-height:1.7;color:#374151}
</style></head><body>
  <h1>resolve-studio · 工作区代码分析</h1>
  <p class="meta">生成时间 ${esc(new Date().toLocaleString('zh-CN'))} · 引擎：serena (LSP) · 收录自 crewai-pse 文章清单（仅含「有 GitHub 链接 + 已写文章」的项目）</p>
  <div class="legend">
    <span><b>${results.length}</b> 个项目</span>
    <span><b>${analyzed}</b> 已深度分析（符号+诊断）</span>
    <span><b>${mixed}</b> 混仓（按语言分别激活）</span>
    <span><b>${lspMissing}</b> 仅列结构（LSP 未安装）</span>
    <span><b>${noCode}</b> 无源码/目录缺失</span>
  </div>
  <div class="summary">${projects.map(projectCard).join('')}</div>
  ${projects.map(projectSection).join('')}
  <script>
    async function rescanProject(key, btn) {
      if (btn.disabled) return
      btn.disabled = true
      btn.classList.add('scanning')
      btn.textContent = '扫描中...'
      try {
        const res = await fetch('/api/workspace/rescan/' + encodeURIComponent(key), { method: 'POST' })
        const data = await res.json()
        if (res.ok) {
          btn.textContent = '已启动'
          // Poll status until done
          const poll = setInterval(async () => {
            try {
              const stRes = await fetch('/api/workspace/status')
              const st = await stRes.json()
              if (st.status !== 'running' || (st.processed && st.processed.includes(key))) {
                clearInterval(poll)
                btn.textContent = '重新扫描'
                btn.disabled = false
                btn.classList.remove('scanning')
                // Reload page to show updated results
                setTimeout(() => location.reload(), 500)
              }
            } catch { clearInterval(poll) }
          }, 3000)
        } else {
          btn.textContent = data.error || '启动失败'
          setTimeout(() => { btn.textContent = '重新扫描'; btn.disabled = false; btn.classList.remove('scanning') }, 2000)
        }
      } catch (err) {
        btn.textContent = '网络错误'
        setTimeout(() => { btn.textContent = '重新扫描'; btn.disabled = false; btn.classList.remove('scanning') }, 2000)
      }
    }
  </script>
</body></html>`
  return html
}

mkdirSync(OUT_DIR, { recursive: true })
// 扫描完成：正常结束置 done；被 SIGTERM 中断置 terminated。
writeStatus({
  status: aborted ? 'terminated' : 'done',
  startedAt,
  finishedAt: new Date().toISOString(),
  total: projects.length,
  current: results.length,
  currentKey: '',
  processed: results.map((r) => r.key),
  skipped,
  pid: process.pid,
})
console.error('WROTE', OUT_DIR + '/index.html')
console.error('WROTE', PROJECTS_JSON)
const _analyzed = results.filter((r) => r.lspStatus === 'ok').length
const _mixed = results.filter((r) => r.mixed).length
const _lspMissing = results.filter((r) => r.lspStatus === 'lsp-missing').length
const _noCode = results.filter(
  (r) => r.lspStatus === 'no-lsp-needed' || r.status === 'missing',
).length
console.error(
  `SUMMARY analyzed=${_analyzed} mixed=${_mixed} lspMissing=${_lspMissing} noCode=${_noCode} totalSym=${results.reduce((n, r) => n + (r.symbolCount || 0), 0)}`,
)
