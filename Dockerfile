# ---- build stage ----
FROM node:22-alpine AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json ./packages/core/
COPY packages/plugin-hello/package.json ./packages/plugin-hello/
COPY packages/plugin-pse/package.json ./packages/plugin-pse/
COPY packages/plugin-system-info/package.json ./packages/plugin-system-info/

RUN pnpm install --frozen-lockfile

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
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git make \
      python3 python3-venv python3-pip \
      libgomp1 libmagic1 \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable && corepack prepare pnpm@9 --activate \
    && python3 -m pip install --no-cache-dir --break-system-packages uv \
    && uv --version

ENV NODE_ENV=production
ENV PORT=8787
ENV HOST=0.0.0.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json ./packages/core/
COPY packages/plugin-hello/package.json ./packages/plugin-hello/
COPY packages/plugin-pse/package.json ./packages/plugin-pse/
COPY packages/plugin-system-info/package.json ./packages/plugin-system-info/

RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/plugin-pse/dist ./packages/plugin-pse/dist
COPY cordis*.yml ./
COPY resolve-skills ./resolve-skills

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1

CMD ["node", "packages/core/dist/index.js", "--config", "cordis.openai.web.yml"]
