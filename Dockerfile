# ---- build stage ----
FROM node:22-alpine AS builder
WORKDIR /app

# npm/pnpm 一律直连 registry.npmjs.org（容器内实测直连可达）。
# 关键坑：宿主 shell 常带 HTTPS_PROXY=http://127.0.0.1:7897，会被 compose 自动透传成
# build arg 注入每个 RUN，而容器内 127.0.0.1 指向容器自身 → 连接被拒（ECONNREFUSED）。
# 因此本 stage 所有 RUN 开头统一 unset 代理，强制直连。
# corepack 用 Node fetch 不读 env 代理，故不用 corepack，改用 npm -g 装 pnpm。
RUN set -e; unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy; \
    npm install -g pnpm@9

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json ./packages/core/
COPY packages/plugin-hello/package.json ./packages/plugin-hello/
COPY packages/plugin-pse/package.json ./packages/plugin-pse/
COPY packages/plugin-system-info/package.json ./packages/plugin-system-info/

# 直连偶发抖动（ECONNRESET），降并发 + 加足重试。
RUN set -e; unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy; \
    pnpm install --frozen-lockfile --network-concurrency=4 --fetch-retries=5

COPY packages/core ./packages/core
COPY packages/plugin-hello ./packages/plugin-hello
COPY packages/plugin-pse ./packages/plugin-pse
COPY packages/plugin-system-info ./packages/plugin-system-info
COPY cordis*.yml ./
COPY resolve-skills ./resolve-skills
COPY scripts ./scripts

RUN pnpm -C packages/plugin-pse run build
RUN pnpm -C packages/core run build

# ---- runtime stage ----
# 运行阶段必须用 Debian(glibc)，不能用 Alpine(musl)：容器内要跑各 PSE 框架的
# `uv run`，而 PyPI 上大量二进制包只发 manylinux(glibc) wheel、不发 musllinux。
# 典型例子：crewai 经 chromadb 依赖的 onnxruntime==1.27.0 在 musl-aarch64 上直接
# 解析失败（uv: "doesn't have a source distribution or wheel for the current
# platform"），会让 article-discover / validate / publish / archive / articles
# 整条 crewai 工具链失效。换 glibc 后同一份 uv.lock 全部命中 wheel
# （142 个依赖，0 个需要现场编译），无需任何 --no-sync 变通。
# 构建阶段仍留在 Alpine：那里只跑 pnpm（纯 JS），不碰 Python。
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# git 供 MCP git server（@cyanheads/git-mcp-server）调用，也是各 PSE 框架
#   扫描子项目 git remote 的前提；
# python3 + uv 供 PSE 工具（hot-news-* / crewai-* / resume-tailor 等）执行框架内
#   Python 脚本；python3-venv 供 uv 之外的回退路径（python3 -m venv）；
# make/curl/wget 供 crewai-publish / dev-stats / wp-publish / portfolio-check
#   等工具调用，wget 同时供 HEALTHCHECK 使用；
# libgomp1 是 lightgbm/xgboost 的 OpenMP 运行库（asset-lens portfolio-check 需要）；
# libmagic1 是 python-magic 的原生库（文档库检索工具需要）。
# bookworm 的 pip 同样受 PEP 668 保护，需 --break-system-packages 才能全局装 uv。
# uv 的安装移到底部代理 env 就位后执行（PyPI 直连同样被墙，见下方说明）。
# 注意：BuildKit 会把 build-arg 的 HTTPS_PROXY 注入每个 RUN 环境（无论 ARG 声明位置），
# 而本地代理对 http apt 仓库偶发 502——故本块先 unset 代理，apt 保持直连。
RUN set -e; unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy; \
    apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git make \
      python3 python3-venv python3-pip \
      libgomp1 libmagic1 \
    && rm -rf /var/lib/apt/lists/*

# ---- 浏览器（已移出镜像）----
# Chrome / Xvfb / VNC 全部迁至共享容器 browser-desk（仓库根 browser-desk/）。
# 本镜像不再携带浏览器：browser-open / desktop-login / sf-pw-publish 均经
# playwright-core connectOverCDP 连接 browser-desk:9222（compose 注入 CDP_URL env）。
# 构建代理 ARG 保留：下方 uv 从 PyPI 安装仍需走代理（见 uv 安装块注释）。
ARG HTTPS_PROXY=""
ARG HTTP_PROXY=""

ENV NODE_ENV=production
ENV PORT=8787
ENV HOST=0.0.0.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json ./packages/core/
COPY packages/plugin-hello/package.json ./packages/plugin-hello/
COPY packages/plugin-pse/package.json ./packages/plugin-pse/
COPY packages/plugin-system-info/package.json ./packages/plugin-system-info/

# uv 从 PyPI 安装：PyPI 直连不通，需走构建代理（ARG HTTPS_PROXY 已在浏览器块声明，
# 此处引用其值，构建时传 --build-arg HTTPS_PROXY=http://host.docker.internal:<port>）。
ENV HTTPS_PROXY=$HTTPS_PROXY
ENV HTTP_PROXY=$HTTP_PROXY
RUN python3 -m pip install --no-cache-dir --break-system-packages uv \
    && uv --version
# npm/pnpm 直连（npmjs 容器内直连可达；unset 防 127.0.0.1 自指代理注入，见 build stage）。
# 装完清空代理 env，避免 node 运行时误带（backend 内部走局域网网关）。
RUN set -e; unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy; \
    npm install -g pnpm@9 \
    && pnpm install --frozen-lockfile --prod --network-concurrency=4 --fetch-retries=5
ENV HTTPS_PROXY=
ENV HTTP_PROXY=

COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/plugin-pse/dist ./packages/plugin-pse/dist
COPY cordis*.yml ./
COPY resolve-skills ./resolve-skills
COPY docker/entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["docker-entrypoint.sh"]

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1

CMD ["node", "packages/core/dist/index.js", "--config", "cordis.openai.web.yml"]
