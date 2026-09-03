/**
 * Tasks service tests: professional tool-set selection by intent matching.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import { tasks as tasksPlugin, type TasksService } from '../src/plugins/tasks.js'
test('match finds the right task from a natural-language request', async () => {
  const ctx = new Context()
  await ctx.plugin(tasksPlugin)

  const svc = ctx.get('tasks') as unknown as TasksService
  assert.ok(svc)

  // 技术文章写作
  let hit = svc.match('帮我写一篇技术文章，要中英双语')
  assert.equal(hit?.id, 'articles')
  hit = svc.match('把这篇稿子发布到掘金')
  assert.equal(hit?.id, 'articles')

  // 热点营销
  hit = svc.match('抓取最新的热点新闻素材，写小红书文案')
  assert.equal(hit?.id, 'hotnews')

  // 投资分析
  hit = svc.match('看看今天全市场技术信号，做投资分析')
  assert.equal(hit?.id, 'investment')
  hit = svc.match('帮我对这个 csv 做分析')
  assert.equal(hit?.id, 'investment')

  // 隐私审计
  hit = svc.match('帮我审计 repo 有没有隐私泄露')
  assert.equal(hit?.id, 'privacy')

  await ctx.fiber.dispose()
})

test('specific keywords outrank generic ones when both are present', async () => {
  const ctx = new Context()
  await ctx.plugin(tasksPlugin)
  const svc = ctx.get('tasks') as unknown as TasksService

  // Generic '搜索' (documents) loses to the more specific '搜索一下' (web).
  let hit = svc.match('搜索一下这个项目怎么用')
  assert.equal(hit?.id, 'web')

  // '分析' alone is ambiguous; pairing it with '投资' still lands on investment.
  hit = svc.match('帮我分析一下投资的事')
  assert.equal(hit?.id, 'investment')

  // A phrase built only from specific task keywords resolves cleanly.
  hit = svc.match('帮我检索文档库里的内容')
  assert.equal(hit?.id, 'documents')

  await ctx.fiber.dispose()
})

test('expanded keywords and new tool owners improve coverage', async () => {
  const ctx = new Context()
  await ctx.plugin(tasksPlugin)
  const svc = ctx.get('tasks') as unknown as TasksService

  // Fresh keyword additions map to the intended task.
  assert.equal(svc.match('写一篇小红书种草文案，要爆款引流')?.id, 'hotnews')
  assert.equal(svc.match('帮我查一下官网的报价')?.id, 'web')
  assert.equal(svc.match('帮我把简历改得更适合这个岗位')?.id, 'recruiting')
  assert.equal(svc.match('批量把 word 文档转换成 markdown')?.id, 'documents')

  // Newly adopted tools land in the right task whitelists.
  const articles = svc.get('articles')!
  assert.ok(articles.includeTools.includes('pick-post'), 'pick-post belongs to articles')
  const foundation = svc.get('foundation')!
  assert.ok(foundation.includeTools.includes('system-info'), 'system-info belongs to foundation')
  assert.ok(foundation.includeTools.includes('calculator'), 'calculator belongs to foundation')

  await ctx.fiber.dispose()
})

test('match returns undefined for open-ended requests', async () => {
  const ctx = new Context()
  await ctx.plugin(tasksPlugin)
  const svc = ctx.get('tasks') as unknown as TasksService

  assert.equal(svc.match('你好，介绍一下你自己'), undefined)
  assert.equal(svc.match('1+1 等于几'), undefined)

  await ctx.fiber.dispose()
})

test('agentOptions produces an include whitelist and guards system prompt', async () => {
  const ctx = new Context()
  await ctx.plugin(tasksPlugin)
  const svc = ctx.get('tasks') as unknown as TasksService

  const task = svc.match('帮我写一篇技术文章并发布')
  assert.equal(task?.id, 'articles')
  const opts = svc.agentOptions(task!)
  assert.ok(opts.includeTools.includes('article-write'))
  assert.ok(opts.includeTools.includes('article-publish'))
  // Task whitelist must NOT leak unrelated professional tools.
  assert.ok(!opts.includeTools.includes('privacy-audit'))
  assert.match(opts.systemPrompt ?? '', /任务说明/)

  await ctx.fiber.dispose()
})

test('custom tasks from config replace built-in defaults by id', async () => {
  const ctx = new Context()
  await ctx.plugin(tasksPlugin, {
    tasks: [
      { id: 'articles', name: '改名', description: 'x', keywords: ['zzz'], includeTools: ['x'] },
    ],
  })
  const svc = ctx.get('tasks') as unknown as TasksService
  const hit = svc.match('帮我写文章')
  // keywords replaced → 写文章 no longer matches anything under this id.
  assert.equal(hit, undefined)
  const hit2 = svc.match('zzz')
  assert.equal(hit2?.id, 'articles')
  assert.equal(hit2?.name, '改名')

  await ctx.fiber.dispose()
})
