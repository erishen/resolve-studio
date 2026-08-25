# agent-harness — pnpm workspace monorepo
#
# 结构：
#   packages/core      → @agent-harness/core（运行时：loader/services/plugins），tsx 源码直跑
#   packages/plugin-*  → 自写 Cordis 插件（如 @agent-harness/plugin-hello）
#   apps/web           → @agent-harness/web（Vite+React 前端，/api 代理到后端 :8787）
#
# 设计约定：
#   - 包管理器固定用 pnpm workspace。
#   - 后端默认用真实模型 cordis.openai.web.yml（需 .env 填密钥）。
#   - 离线 mock：make dev-mock（cordis.web.yml，无需网络/密钥）。
#   - 浏览器访问：http://127.0.0.1:5173 （/api 由 Vite 代理到后端 :8787）。
#
# 用法示例：
#   make            # 默认 = make install
#   make install    # 装全部 workspace 依赖
#   make check      # typecheck(core) + test(core)
#   make dev        # 起后端(真实模型)+前端 dev，开浏览器即可聊
#   make dev-mock   # 起后端(mock)+前端 dev（离线，无需密钥）
#   make stop       # 停掉 dev / dev-mock 起的后台进程

SHELL := /bin/zsh
.DEFAULT_GOAL := install

# ---- 可覆盖变量 ----
BACKEND_PORT ?= 8787
WEB_PORT     ?= 5173
CONFIG       ?= cordis.web.yml
REAL_CONFIG  ?= cordis.openai.web.yml

# dev 默认走真实模型；dev-mock 走离线 mock
DEV_CONFIG   ?= $(REAL_CONFIG)

ROOT  := $(CURDIR)
CORE  := $(ROOT)/packages/core
WEB   := $(ROOT)/apps/web
PID_DIR := $(ROOT)/.run

# 进程特征（pkill 精确停，不依赖 PID 文件）
BACKEND_BIN  := packages/core/src/index.ts
BACKEND_MATCH := $(BACKEND_BIN) --config
WEB_MATCH     := vite --host 127.0.0.1 --port $(WEB_PORT)

.PHONY: all install typecheck test check build build-web \
        chat chat-real dev dev-mock stop clean help new-plugin manifests

all: install

install:           ## 装全部 workspace 依赖
	pnpm install

typecheck:         ## core typecheck
	pnpm -C $(CORE) run typecheck

test:              ## 跑 core 单元测试
	pnpm -C $(CORE) test

check: typecheck test  ## typecheck + test

build:             ## 编译 core 到 packages/core/dist/
	pnpm -C $(CORE) run build

build-web:         ## 构建前端到 apps/web/dist/
	pnpm -C $(WEB) run build

new-plugin:        ## 生成新插件包：make new-plugin name=weather
	node scripts/new-plugin.mjs $(name)

manifests:         ## 重新生成 4 份 cordis*.yml（单源：scripts/gen-manifests.mjs）
	node scripts/gen-manifests.mjs

# ---- 运行 ----

chat:              ## 起后端 CLI（默认 cordis.yml）
	node --import tsx $(CORE)/src/index.ts --config cordis.yml

chat-real:         ## 起后端 CLI（真实模型）
	node --import tsx $(CORE)/src/index.ts --config $(REAL_CONFIG)

$(PID_DIR):
	@mkdir -p $(PID_DIR)

dev: $(PID_DIR)    ## 后端(真实模型)+前端 dev（前台常驻，Ctrl-C 退出）
	@echo "starting backend (real model) on :$(BACKEND_PORT) && web dev on :$(WEB_PORT) ..."; \
	node --import tsx $(CORE)/src/index.ts --config $(DEV_CONFIG) > $(PID_DIR)/backend.log 2>&1 & BACKEND_PID=$$!; \
	cd $(WEB) && pnpm exec vite --host 127.0.0.1 --port $(WEB_PORT) > $(PID_DIR)/web.log 2>&1 & WEB_PID=$$!; \
	echo "ready: http://127.0.0.1:$(WEB_PORT)  (backend :$(BACKEND_PORT), real model)"; \
	echo "Ctrl-C to stop. logs: $(PID_DIR)/backend.log $(PID_DIR)/web.log"; \
	trap 'kill $$BACKEND_PID $$WEB_PID 2>/dev/null; echo; echo stopped' EXIT INT TERM; \
	wait

dev-mock: $(PID_DIR)  ## 后端(mock)+前端 dev（离线，无需密钥，Ctrl-C 退出）
	@echo "starting backend (mock) on :$(BACKEND_PORT) && web dev on :$(WEB_PORT) ..."; \
	node --import tsx $(CORE)/src/index.ts --config $(CONFIG) > $(PID_DIR)/backend.log 2>&1 & BACKEND_PID=$$!; \
	cd $(WEB) && pnpm exec vite --host 127.0.0.1 --port $(WEB_PORT) > $(PID_DIR)/web.log 2>&1 & WEB_PID=$$!; \
	echo "ready: http://127.0.0.1:$(WEB_PORT)  (backend :$(BACKEND_PORT), mock)"; \
	echo "Ctrl-C to stop. logs: $(PID_DIR)/backend.log $(PID_DIR)/web.log"; \
	trap 'kill $$BACKEND_PID $$WEB_PID 2>/dev/null; echo; echo stopped' EXIT INT TERM; \
	wait

stop:              ## 若用 nohup 分离启动过，可手动停（dev 用 Ctrl-C 即可）
	-@pkill -f "$(BACKEND_MATCH)" && echo "stopped backend" || echo "no backend running"
	-@pkill -f "$(WEB_MATCH)" && echo "stopped web" || echo "no web running"

clean:             ## 清构建产物
	rm -rf $(CORE)/dist $(WEB)/dist $(WEB)/node_modules $(PID_DIR)
	@echo "cleaned"

help:              ## 显示本帮助
	@echo "可用目标（make <目标>）："
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "} {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'
