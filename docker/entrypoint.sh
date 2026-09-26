#!/bin/sh
# resolve-studio backend 容器入口
# 容器内没有真实显示器，但 sf-pw-publish（思否发布）的 Playwright 脚本是 headless:false
# 有头模式，必须先起一个虚拟 X server 再跑主进程（Xvfb 在 Debian 的 xvfb 包里）。
set -eu

export DISPLAY="${DISPLAY:-:99}"

# 旧实现用 lock 文件判断「Xvfb 是否在跑」，但 Xvfb 崩溃 / 容器重启后
# /tmp/.X99-lock 会残留 → 误判 Xvfb 还活着 → 不再拉起 → Playwright 有头启动
# 报 "launched a headed browser without having a XServer running"。
# 改为无条件清理残留进程与 lock，再幂等拉起 Xvfb。
pkill -f "Xvfb ${DISPLAY}" 2>/dev/null || true
rm -f "/tmp/.X${DISPLAY#:}-lock"
Xvfb "$DISPLAY" -screen 0 1600x1200x24 -nolisten tcp &
sleep 1

# ---- 让 /workspace 挂载树对 agent 的 /app cwd 可见（可发现性修复）----
# agent 的 shell 从 /app 启动，但所有项目源码 bind 挂载在 /workspace。它常试
# `cd crewai-pse`（cwd 是 /app，该目录不存在 → "can't cd to crewai-pse"）或
# `find /`（被 fs-guard 拦，因为 `/` 不在 shellRoots /app,/workspace）。
# 这里把 /workspace 各顶层目录软链进 /app，并单独软链 /app/crewai-pse →
# /workspace/frameworks/crewai-pse。用软链（而非 bind 挂载）是关键：crewai-pse 的
# check_readme_links.py 用 abspath(__file__) 基于「shell cd 后的真实 cwd」向上推算仓库根
# ROOT；软链经 shell `cd` 后 cwd 解析为 /workspace/frameworks/crewai-pse → ROOT=/workspace
# 正确；若改成 bind 挂载（内核映射，cd 后 cwd 仍是 /app/crewai-pse）则 ROOT=/app，
# source_dir 全判缺失。软链都是相对导航（无 `..`、无绝对 token），fs-guard 放行；
# 绝对越界（如 /etc）仍被拦，containment 不破。
if [ -d /workspace ]; then
  for d in /workspace/*/; do
    name=$(basename "$d")
    [ -e "/app/$name" ] || ln -s "$d" "/app/$name" 2>/dev/null || true
  done
  # 针对性：recurring 的 crewai-pse 任务，agent 习惯 `cd crewai-pse`（软链解析到 /workspace）
  [ -e /app/crewai-pse ] || ln -s /workspace/frameworks/crewai-pse /app/crewai-pse 2>/dev/null || true
  cat > /app/README.md <<'README_EOF'
# resolve-studio agent workspace (/app)

你的 shell 从这里（/app）启动。所有项目源码 bind 挂载在 /workspace，并已软链到本目录便于访问：

- crewai-pse  → 软链 /app/crewai-pse → /workspace/frameworks/crewai-pse
              文章回链工具：make check-links / make sync-links
- frameworks/ → /workspace/frameworks  （全部 PSE 框架）
- work/ github/ cnb/ docs/ personal/ invest-kit/ tools/ scripts/ → /workspace/<name>

推荐用法（守卫都放行，shell `cd` 经软链解析到 /workspace 真实路径）：
  cd crewai-pse && make check-links              # ← 首选：/app 下软链，cd 后真实路径在 /workspace
  cd frameworks/crewai-pse && make check-links
  cd /workspace/frameworks/crewai-pse && make check-links

注意：不要 `find /` 扫整个根——fs-guard 仅允许 /app 与 /workspace。需要全局搜索用 `find /workspace ...`。
注意：/workspace 是仓库挂载根（没有 Makefile），crewai-pse 在 /workspace/frameworks/crewai-pse。
README_EOF
fi

exec "$@"
