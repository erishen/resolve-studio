# resolve-studio — pnpm workspace monorepo
#
# 结构：
#   packages/core      → @resolve-studio/core（运行时：loader/services/plugins），tsx 源码直跑
#   packages/plugin-*  → 自写 Cordis 插件（如 @resolve-studio/plugin-hello）
#   apps/web           → @resolve-studio/web（Vite+React 前端，/api 代理到后端 :8787）
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
#   make dev        # 起后端(真实模型)+前端 dev（前台常驻，Ctrl-C 退出）
#   make dev-mock   # 起后端(mock)+前端 dev（离线，无需密钥）
#   make dev-bg     # 同上但后台常驻：脱离终端，关窗口/会话回收都不停（配 dev-bg-status / dev-bg-stop）
#   make stop       # 停掉 dev / dev-mock 起的后台进程
#   make secret-scan # 本地全量密钥扫描（防泄露，公开前必跑）
#   make hook-init  # 启用提交前自动密钥扫描钩子
#   make publish    # 发布所有 plugin-* 包：make publish OTP=123456（需 npm 登录 + 2FA）
#   make publish-dry # 预演发布（不上传）：make publish-dry
#   make release    # 三包版本自增并发布：make release OTP=123456 [VERSION=minor]

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

# BACKEND_MATCH 必须同时锚定「启动方式」和「本项目入口文件」两件事：
#   - 只写 `--import tsx` 会误杀机器上任何用 tsx 启动的 node 进程（别的项目的
#     dev server 也在这个模式里）；
#   - 只写入口文件又可能匹配到编辑器/其他工具打开的同名文件进程。
# 两者都写，误杀面就收敛到「本项目的后端」。
# 不锚 `^node`：argv[0] 可能是 node 的绝对路径（nvm / volta shim），锚死会漏匹配。
# `$(subst .,[.],...)` 把入口路径的点号转义：清理命令自身的 argv 里是字面量
# `index[.]ts`，而正则只匹配真实的 `index.ts`，因此不会自杀（同 WEB_MATCH 的技巧）。
BACKEND_BIN  := packages/core/src/index.ts
BACKEND_MATCH := --import tsx .*$(subst .,[.],$(BACKEND_BIN))
WEB_MATCH     := vite[.]js --host 127.0.0.1 --port $(WEB_PORT)

.PHONY: all install typecheck test check build build-web \
        chat chat-real dev dev-mock dev-bg dev-bg-mock dev-bg-stop dev-bg-status dev-bg-restart \
        stop clean help new-plugin manifests \
        lint lint-fix format format-check docker-build docker-up docker-down logs \
        secret-scan hook-init publish publish-dry release

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

# 启动前检查并清理占用端口的旧进程（防止 EADDRINUSE）
define kill_port
	@if lsof -ti :$(1) >/dev/null 2>&1; then \
		echo "port $(1) in use, killing old process..."; \
		lsof -ti :$(1) | xargs kill -9 2>/dev/null; \
		sleep 1; \
	fi
endef

# 后端就绪探测：起 vite 之前先等 :$(BACKEND_PORT) 真能应答。
# 之前后端与 vite 是同一批 `&` 起步的，而后端（tsx 冷启动 + MCP 握手）比 vite 慢好几秒，
# 于是前端首屏的 /api/sessions /api/models 全被 vite 反代打成
# `ECONNREFUSED 127.0.0.1:8787`（见 .run/web.log），页面一打开就一片红。
# 用 HTTP 探测而非 lsof：端口 LISTEN ≠ 路由已注册；只要拿到任意 HTTP 状态码
# （200/401/404 都算）即视为就绪，因此有没有鉴权都不影响判定。
# `--noproxy '*'` 是必须的：本机有 http_proxy 时，curl 会把 127.0.0.1 的请求也发给代理，
# 连不上的端口会拿到代理回的 502 而不是 000 —— 于是后端还没起来就误判成「ready」，
# 竞态等于没修（探针只认 000 为「没起来」）。
# 超时不阻断：万一后端起不来，也照常把前端拉起来，只提示一句，避免 make dev 卡死。
BACKEND_PROBE        ?= /api/models
BACKEND_WAIT_TIMEOUT ?= 60

# 注意：define 里第一行的 `@` 要省略——它展开后落在续行中间（不是逻辑行首），
# make 不会剥离 `@`，shell 会当成命令名 `@printf` 而报 command not found。
# 调用处也必须写成 `$(call wait_backend); \`：末尾 `fi` 自带的分隔符补不上，
# 少了这个分号会把后面的 `cd $(WEB) && vite` 粘连成 `fi cd ...` 语法错误。
define wait_backend
	printf 'waiting for backend on :$(BACKEND_PORT) '; \
	i=0; \
	while [ $$i -lt $(BACKEND_WAIT_TIMEOUT) ]; do \
		code=$$(curl -s -m 2 --noproxy '*' -o /dev/null -w '%{http_code}' http://127.0.0.1:$(BACKEND_PORT)$(BACKEND_PROBE) 2>/dev/null); \
		if [ -n "$$code" ] && [ "$$code" != "000" ]; then break; fi; \
		i=$$((i + 1)); \
		printf '.'; \
		sleep 1; \
	done; \
	if [ $$i -ge $(BACKEND_WAIT_TIMEOUT) ]; then \
		echo " timeout after $(BACKEND_WAIT_TIMEOUT)s (starting web anyway)"; \
	else \
		echo " ready"; \
	fi
endef

# 退出诊断：`wait` 返回 = 有后台 job 退出了（后端崩、前端崩），随后 EXIT trap 会 pkill
# 掉剩下的那个再打印 `stopped`。也就是说 `stopped` 有三种来源，原来长得一模一样，
# 完全分不清是「你按了 Ctrl-C」还是「服务自己挂了」——后者正是「跑着跑着自己停」的真相，
# 却被一行 stopped 盖住了。这里在打印 stopped 之前先把谁退了、去哪看日志说清楚。
# 后端判活用 HTTP 而不是 pid：后端是 `node | tee` 的管道 job，`$!` 拿到的是 tee 而不是
# node，拿它判活会失真（tee 健在并不代表后端还在）。
define diagnose_exit
	echo "" >&2; \
	echo "[dev] ⚠️  有服务提前退出（不是 Ctrl-C），正在判断是谁：" >&2; \
	code=$$(curl -s -m 2 --noproxy '*' -o /dev/null -w '%{http_code}' http://127.0.0.1:$(BACKEND_PORT)$(BACKEND_PROBE) 2>/dev/null); \
	if [ -z "$$code" ] || [ "$$code" = "000" ]; then \
		echo "[dev]    ❌ 后端已不在响应 :$(BACKEND_PORT) —— 看日志：tail -50 $(PID_DIR)/backend.log" >&2; \
	else \
		echo "[dev]    ✅ 后端仍在响应 :$(BACKEND_PORT)" >&2; \
	fi; \
	if kill -0 $$WEB_PID 2>/dev/null; then \
		echo "[dev]    ✅ 前端(vite)仍在运行 (pid $$WEB_PID)" >&2; \
	else \
		echo "[dev]    ❌ 前端(vite)已退出 (pid $$WEB_PID) —— 看日志：tail -50 $(PID_DIR)/web.log" >&2; \
	fi; \
	echo "[dev]    提示：另开一个终端跑 make dev 时，开头的 kill_port 会杀掉这里的旧进程，同样表现为 stopped。" >&2
endef

# ⚠️ Ctrl-C / 关终端 / IDE 任务结束 → shell 收到 INT/TERM：INT/TERM trap 设 DEV_INT=1、
# pkill 掉后端与 vite、然后 `exit 130` 直接退出（EXIT trap 再补一行 `stopped`）。因为
# 信号路径直接 exit，不会落到下面的 `wait` 之后，所以 diagnose_exit（崩溃诊断）被 DEV_INT
# 守卫跳过 —— Ctrl-C 不再误报成「有服务提前退出（不是 Ctrl-C）」。
# 只有「后台 job 自己挂了、wait 正常返回、DEV_INT 仍为 0」才会触发 diagnose_exit 并打印
# 上面那几行「谁退了 / 去哪看日志」，随后 EXIT trap 打印 `stopped`。
# 日志里出现 N 行 stopped = 有 N 个 dev 会话退出了；带 diagnose 输出的 stopped = 真·崩溃。
# 想彻底不停：make dev-bg（服务被 spawn 到独立会话，与终端/会话生命周期解耦）。
# trap 放在启动之前：否则后端已起、等待就绪期间按 Ctrl-C 会留下没人管的孤儿后端。
dev: $(PID_DIR)    ## 后端(真实模型)+前端 dev（前台常驻，Ctrl-C 退出）
	-@pkill -f "$(BACKEND_MATCH)" 2>/dev/null; pkill -f "$(WEB_MATCH)" 2>/dev/null; true
	$(call kill_port,$(BACKEND_PORT))
	$(call kill_port,$(WEB_PORT))
	@echo "starting backend (real model) on :$(BACKEND_PORT) ..."; \
	echo "--- backend log (live, colored) ---"; \
	DEV_INT=0; \
	trap 'DEV_INT=1; pkill -f "$(BACKEND_MATCH)" 2>/dev/null; pkill -f "$(WEB_MATCH)" 2>/dev/null; echo; exit 130' INT TERM; \
	trap 'pkill -f "$(BACKEND_MATCH)" 2>/dev/null; pkill -f "$(WEB_MATCH)" 2>/dev/null; echo; echo stopped' EXIT; \
	FORCE_COLOR=1 node --import tsx $(CORE)/src/index.ts --config $(DEV_CONFIG) 2>&1 | tee $(PID_DIR)/backend.log & \
	$(call wait_backend); \
	cd $(WEB) && pnpm exec vite --host 127.0.0.1 --port $(WEB_PORT) > $(PID_DIR)/web.log 2>&1 & \
	WEB_PID=$$!; \
	echo "ready: http://127.0.0.1:$(WEB_PORT)  (backend :$(BACKEND_PORT), real model)"; \
	echo "Ctrl-C to stop. web log: $(PID_DIR)/web.log"; \
	wait; \
	if [ $$DEV_INT -ne 1 ]; then $(call diagnose_exit); fi; \

dev-mock: $(PID_DIR)  ## 后端(mock)+前端 dev（离线，无需密钥，Ctrl-C 退出）
	-@pkill -f "$(BACKEND_MATCH)" 2>/dev/null; pkill -f "$(WEB_MATCH)" 2>/dev/null; true
	$(call kill_port,$(BACKEND_PORT))
	$(call kill_port,$(WEB_PORT))
	@echo "starting backend (mock) on :$(BACKEND_PORT) ..."; \
	echo "--- backend log (live, colored) ---"; \
	DEV_INT=0; \
	trap 'DEV_INT=1; pkill -f "$(BACKEND_MATCH)" 2>/dev/null; pkill -f "$(WEB_MATCH)" 2>/dev/null; echo; exit 130' INT TERM; \
	trap 'pkill -f "$(BACKEND_MATCH)" 2>/dev/null; pkill -f "$(WEB_MATCH)" 2>/dev/null; echo; echo stopped' EXIT; \
	FORCE_COLOR=1 node --import tsx $(CORE)/src/index.ts --config $(CONFIG) 2>&1 | tee $(PID_DIR)/backend.log & \
	$(call wait_backend); \
	cd $(WEB) && pnpm exec vite --host 127.0.0.1 --port $(WEB_PORT) > $(PID_DIR)/web.log 2>&1 & \
	WEB_PID=$$!; \
	echo "ready: http://127.0.0.1:$(WEB_PORT)  (backend :$(BACKEND_PORT), mock)"; \
	echo "Ctrl-C to stop. web log: $(PID_DIR)/web.log"; \
	wait; \
	if [ $$DEV_INT -ne 1 ]; then $(call diagnose_exit); fi; \

# ⚠️ 上面两个目标打印的 `stopped` 不是崩溃：dev 挂在前台，会话一结束（Ctrl-C / 关终端 /
# IDE 任务结束 / 上层工具回收进程组）shell 就会收到 INT/TERM/EXIT，trap 先停服务再打印它。
# **想让它一直跑就用 dev-bg**：服务被 spawn 到独立的会话与进程组，不再挂在当前终端下，
# 关窗口也不会停；只有 `make dev-bg-stop` 才停。
dev-bg: $(PID_DIR)      ## 后台常驻：起后端(真实模型)+前端，关终端/会话回收都不停
	@node scripts/dev-bg.mjs start

dev-bg-mock: $(PID_DIR) ## 后台常驻：起后端(mock)+前端（离线，无需密钥）
	@node scripts/dev-bg.mjs start --mock

dev-bg-stop:            ## 停掉 dev-bg 起的常驻实例（整组 TERM，不留孤儿）
	@node scripts/dev-bg.mjs stop

dev-bg-status:          ## 查看常驻实例：pid + 端口是否还在监听
	@node scripts/dev-bg.mjs status

dev-bg-restart:         ## 重启常驻实例
	@node scripts/dev-bg.mjs restart

logs:              ## 实时查看后端和前端日志
	@echo "=== backend log ===" && tail -f $(PID_DIR)/backend.log & \
	echo "=== web log ===" && tail -f $(PID_DIR)/web.log

stop:              ## 若用 nohup 分离启动过，可手动停（dev 用 Ctrl-C 即可）
	-@pkill -f "$(BACKEND_MATCH)" && echo "stopped backend" || echo "no backend running"
	-@pkill -f "$(WEB_MATCH)" && echo "stopped web" || echo "no web running"

clean:             ## 清构建产物
	rm -rf $(CORE)/dist $(WEB)/dist $(WEB)/node_modules $(PID_DIR)
	@echo "cleaned"

lint:              ## ESLint 检查
	pnpm run lint

lint-fix:          ## ESLint 自动修复
	pnpm run lint:fix

format:            ## Prettier 格式化
	pnpm run format

format-check:      ## Prettier 格式检查
	pnpm run format:check

secret-scan:       ## 本地全量密钥扫描（需 gitleaks）
	@command -v gitleaks >/dev/null 2>&1 || { echo "gitleaks 未安装：brew install gitleaks"; exit 1; }
	gitleaks detect --source=. --config=.gitleaks.toml --redact --no-banner

hook-init:         ## 启用本地 pre-commit 密钥扫描钩子
	git config core.hooksPath .githooks
	@echo "已启用 .githooks/pre-commit（提交前自动扫描密钥）"

# ---- 发布 ----

PLUGIN_PKGS := $(wildcard packages/plugin-*)
OTP         ?=
VERSION     ?= patch

publish:            ## 发布所有 packages/plugin-* 到 npm：make publish OTP=123456
	@for d in $(PLUGIN_PKGS); do \
		echo "=== publishing $$d ==="; \
		if [ -n "$(OTP)" ]; then \
			(cd $$d && npm publish --otp=$(OTP)) || exit 1; \
		else \
			(cd $$d && npm publish) || exit 1; \
		fi; \
	done

publish-dry:        ## 预演发布（不真正上传）：make publish-dry
	@for d in $(PLUGIN_PKGS); do \
		echo "=== dry-run $$d ==="; \
		(cd $$d && npm publish --dry-run) || exit 1; \
	done

release:            ## 三包版本自增(patch/minor/major)并发布：make release OTP=123456 [VERSION=minor]
	@for d in $(PLUGIN_PKGS); do \
		echo "=== bump $$d ($(VERSION)) ==="; \
		(cd $$d && npm version $(VERSION) --no-git-tag-version) || exit 1; \
	done
	pnpm install
	@$(MAKE) publish OTP=$(OTP)

docker-build:      ## 构建 Docker 镜像
	docker compose build

docker-up:         ## 启动 Docker 容器（后端+前端）
	docker compose up -d

docker-down:       ## 停止 Docker 容器
	docker compose down

help:              ## 显示本帮助
	@echo "可用目标（make <目标>）："
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "} {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'
