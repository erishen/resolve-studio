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
FROM node:22-alpine AS runtime
WORKDIR /app

# git 供 MCP git server（@cyanheads/git-mcp-server）在容器内调用；
# python3 + uv 供 PSE 工具（hot-news-* / resume-tailor 等）执行框架内 Python 脚本。
# alpine 的 pip 受 PEP 668 保护，需 --break-system-packages 才能全局安装 uv
RUN apk add --no-cache git python3 py3-pip && \
    corepack enable && corepack prepare pnpm@9 --activate && \
    pip install --no-cache-dir --break-system-packages uv && \
    ln -s /usr/bin/uv /usr/local/bin/uv || true

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
