#!/bin/sh
# resolve-studio backend 容器入口
# 容器内没有真实显示器，但 sf-pw-publish（思否发布）的 Playwright 脚本是 headless:false
# 有头模式，必须先起一个虚拟 X server 再跑主进程（Xvfb 在 Debian 的 xvfb 包里）。
set -eu

export DISPLAY="${DISPLAY:-:99}"
if [ ! -e "/tmp/.X${DISPLAY#:}-lock" ]; then
  Xvfb "$DISPLAY" -screen 0 1600x1200x24 -nolisten tcp &
fi
sleep 1

exec "$@"