import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import * as path from 'node:path'

const execFileAsync = promisify(execFile)

/**
 * life-dash 根（publish-pending 卡片的数据源 articlePublish.json 所在仓库）：
 * LIFE_DASH_DIR 优先，否则从 WORDPRESS_TOOLS_DIR 推（…/personal-site/wordpress-tools
 * → 同级 personal/life-dash）。env-only，不硬编码个人路径。
 */
export function lifeDashRoot(): string | null {
  const l = process.env.LIFE_DASH_DIR
  if (l) return l
  const wp = process.env.WORDPRESS_TOOLS_DIR
  if (wp) return path.join(wp, '..', '..', 'life-dash')
  return null
}

/**
 * 发布/归档卡片跑完（frontmatter 已回写 juejin_id/sf_id/wechat_draft_id，或 PSE
 * 已写 wp_id / 重建各平台副本）后，自动重跑 life-dash 的 gen-article-publish.mts
 * 刷新 articlePublish.json，让 publish-pending 卡片读到最新未发清单（等价 life-dash
 * `make rescan` 的数据刷新部分，不重建 life-dash 前端 dist）。
 *
 * best-effort：失败不影响发布本身（frontmatter/副本已落盘），只在结果里给一行提示。
 * 供 tool-wp-publish（make 系）与 tool-crewai-publish（PSE 发布/归档）共用。
 */
export async function resyncPendingList(taskLabel: string): Promise<string> {
  const root = lifeDashRoot()
  const gen = root ? path.join(root, 'scripts', 'gen-article-publish.mts') : ''
  if (!root || !gen || !existsSync(gen)) return ''
  // 容器 compose 会把 ARTICLES_DIR 注入成 …/articles/pse（PSE 子目录），而 life-dash
  // 生成器默认要 …/articles 根 —— 删掉它，让生成器走正确的相对默认路径。
  const env: Record<string, string | undefined> = { ...process.env }
  delete env.ARTICLES_DIR
  try {
    const { stdout } = await execFileAsync(process.execPath, ['--experimental-strip-types', gen], {
      timeout: 60_000,
      maxBuffer: 1 << 20,
      env,
    })
    const summary = (stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? ''
    return `\n\n📋 未发清单已自动同步（等价 life-dash make rescan 数据刷新）：${summary}`
  } catch (e) {
    return `\n\n⚠️ ${taskLabel} 已完成，但自动同步未发清单失败（${(e as Error).message}）。可手动 cd personal/life-dash && make rescan。`
  }
}
