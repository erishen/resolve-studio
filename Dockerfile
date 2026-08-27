# ---- build stage ----
FROM node:22-alpine AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json ./packages/core/
COPY packages/plugin-hello/package.json ./packages/plugin-hello/ 2>/dev/null || true
COPY packages/plugin-system-info/package.json ./packages/plugin-system-info/ 2>/dev/null || true

RUN pnpm install --frozen-lockfile

COPY packages/core ./packages/core
COPY packages/plugin-hello ./packages/plugin-hello 2>/dev/null || true
COPY packages/plugin-system-info ./packages/plugin-system-info 2>/dev/null || true
COPY cordis*.yml ./
COPY skills ./skills 2>/dev/null || true
COPY scripts ./scripts 2>/dev/null || true

RUN pnpm -C packages/core run build

# ---- runtime stage ----
FROM node:22-alpine AS runtime
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9 --activate

ENV NODE_ENV=production
ENV PORT=8787
ENV HOST=0.0.0.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json ./packages/core/
COPY packages/plugin-hello/package.json ./packages/plugin-hello/ 2>/dev/null || true
COPY packages/plugin-system-info/package.json ./packages/plugin-system-info/ 2>/dev/null || true

RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY cordis*.yml ./
COPY skills ./skills 2>/dev/null || true

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1

CMD ["node", "packages/core/dist/index.js", "--config", "cordis.openai.web.yml"]
