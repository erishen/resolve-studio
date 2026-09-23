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

exec "$@"
