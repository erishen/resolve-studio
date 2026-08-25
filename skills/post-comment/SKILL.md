---
name: post-comment
description: 在 erishen.cn 随机挑一篇已发布文章并提交一条评论（测试站内评论/互动）。用户说「帮我给 erishen.cn 找篇文章评论一下」之类时使用
---

# Post Comment 技能（erishen.cn）

适用场景：用户要求在 erishen.cn 随机找篇文章加评论，或测试博客评论功能。

## 步骤

1. **随机选文章**：调用 `pick-post` 工具（**只读，无需审批**），一次调用即可，得到 `{ id, title, link }`。不要重复调用。

2. **看一眼文章**（可选）：用 `browser-open` 打开上一步的 `link`，了解文章主题，好写出有针对性的评论。

3. **提交评论**：用 `shell` 工具运行
   ```
   node skills/post-comment/scripts/random-comment.mjs --post <文章id> --content "<一句话评论>"
   ```
   评论内容：基于文章主题写一句**真诚、具体**的中文评论（别用「好文章」「学习了」这类空话）。评论者默认虚构身份 `程序猿小林 / coder.xiaolin@163.com`（像真实访客的昵称+邮箱，与用户本人无关），如需自定义用 `--name` / `--email` 传入。

4. **汇报结果**：把输出 JSON 转述给用户：文章标题 + 链接 + 评论 id + 状态（`approved` 已通过 / `pending` 待审核）。

## 注意事项

- 这是对**用户自己站点**的写操作，会经过 `shell` 工具的审批（模型请求时用户需批准）。
- erishen.cn 开启了「必须登录后才能评论」——**匿名评论会 401**（`rest_comment_login_required`）。项目 `.env` 里已有的 `PROD_WORDPRESS_USERNAME` / `PROD_WORDPRESS_APP_PASSWORD`（WordPress 应用密码）即可认证：脚本启动时会自动加载 `<cwd>/.env`，检测到这两个变量就带 Basic 认证提交；没配就匿名试、失败把错误**原样转述**给用户，不要猜测或硬塞认证信息（Wordfence 可能拦截应用密码认证，遇 401/403 如实报告）。
- 不要修改/删除已提交的评论；评论内容只由用户要求或模型基于文章生成。
