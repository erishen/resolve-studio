export interface JobExample {
  id: string
  title: string
  prompt: string
}

/**
 * Ready-made prompts for the background long-running jobs panel. All of them
 * stay inside the registered tool/skill surface (see tasks.ts whitelists) and
 * target the job's own workspace as the output sink, so the results show up in
 * the artifact browser. Background jobs run unattended (skip approval), so the
 * examples avoid anything that needs a human confirm mid-run (e.g. publishing).
 */
export const JOB_EXAMPLES: JobExample[] = [
  {
    id: 'job-weekly-investment',
    title: '周度投资复盘',
    prompt:
      '使用 weekly-investment-review 技能做一份周度投资复盘：先用 portfolio-check 刷新快照并扫描数据异常，再用 pse-review 生成深度分析，最后把完整报告用 write-file 保存到工作区（markdown 格式），完成后汇报报告路径和关键结论。',
  },
  {
    id: 'job-stock-scan',
    title: '全市场信号扫描',
    prompt:
      '用 stock-scan 扫描今天全市场的技术信号（趋势/买入/卖出），把结果整理成一份 markdown 报告用 write-file 保存到工作区，包含信号列表、代表标的和免责声明，完成后汇报报告路径。',
  },
  {
    id: 'job-product-research',
    title: '产品与竞品分析',
    prompt:
      '用 product-analyze 研究 Notion AI 这个产品并做竞品分析，把完整的分析报告（产品定位、核心功能、竞品对比、机会与风险）用 write-file 保存到工作区，完成后汇报报告路径和 3 条核心结论。',
  },
  {
    id: 'job-csv-report',
    title: 'CSV 数据分析报告',
    prompt:
      '用 csv-analyze 分析指定 CSV 数据文件，生成带数据剖视、趋势和异常识别的报告，把报告用 write-file 保存到工作区，完成后汇报报告路径与主要发现。',
  },
  {
    id: 'job-hot-news-pipeline',
    title: '热点内容流水线',
    prompt:
      '走一遍热点内容流水线：用 hot-news-fetch 抓取最新多平台热点素材，用 hot-news-topics 列出话题候选（按热度排序），挑选最热话题用 hot-news 生成一篇小红书营销文案，再用 hot-news-check 校验合规。把话题清单和最终文案用 write-file 保存到工作区，完成后汇报。',
  },
  {
    id: 'job-article-draft',
    title: '技术文章草稿',
    prompt:
      '用 article-discover 扫描有哪些 GitHub 项目值得写技术文章，选一个最有价值的，用 article-write 生成一篇中英双语技术文章草稿，用 article-validate 校验正确性。把草稿用 write-file 保存到工作区，完成后汇报草稿路径。',
  },
  {
    id: 'job-privacy-audit',
    title: '隐私泄露审计',
    prompt:
      '用 privacy-audit 对当前 repo 做一遍 9 项隐私自查（硬编码密钥、敏感文件、历史提交等），把审计结果和每项风险的修复建议用 write-file 保存到工作区，完成后汇报报告路径和风险项数。',
  },
  {
    id: 'job-doc-library',
    title: '文档库检索汇总',
    prompt:
      '在本地 markdown 文档库中检索与“AI agent 架构”相关的资料，用 doc-library-search 找到命中的片段和来源路径，把要点整理成一份带来源引用的汇总报告，用 write-file 保存到工作区，完成后汇报。',
  },
  {
    id: 'job-resume-tailor',
    title: '定制简历',
    prompt:
      '用 resume-tailor 定制一份简历：目标岗位 JD 为资深后端工程师（5 年以上 Java/Python、熟悉分布式系统与微服务）。把改写后的简历用 write-file 保存到工作区，完成后汇报简历路径与改动要点。',
  },
  {
    id: 'job-web-research',
    title: '联网调研总结',
    prompt:
      '用浏览器工具调研 MCP 与 A2A 协议的现状（打开官方文档和相关文章，提取正文），对比两者的定位、优劣势和适用场景，把调研结论整理成 markdown 报告用 write-file 保存到工作区，完成后汇报报告路径与要点。',
  },
]
