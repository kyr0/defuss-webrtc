# Project interface (defuss-vae layout): the same verbs for humans, agents and CI; `make` lists them with usage.
# Service: RUN = foreground command; stdout/stderr → var/log/$(NAME).*, pid → tmp/$(NAME).pid (both gitignored).
# The verifier runs lint/test/coverage/e2e on every gate; e2e must leave fresh files in output/.
# Toolchain: this repo stays on npm (root, server/, vercel/ each keep their package-lock.json) until a migration is
# approved; Node is pinned in mise.toml. The service is the Express room server (server/), built before it starts.
NAME ?= server
RUN  ?= npm --prefix server run build && exec node server/dist/index.js
N    ?= 50
export RUN
# Config: KEY=value lines of the gitignored .env reach every recipe and the app `start` runs. Make reads them, so
# `#` starts a comment and `$` must be `$$`; values needing either belong in the app's own .env loader.
-include .env
ENV_KEYS := $(shell sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' .env 2>/dev/null)
ifneq ($(ENV_KEYS),)
export $(ENV_KEYS)
endif
# Installer default dirs as a fallback (uv, bun, mise shims, rustup, go install, dotnet tools): shell recipes find tools
# setup just installed, while tools already on PATH keep precedence.
export PATH := $(PATH):$(HOME)/.local/bin:$(HOME)/.bun/bin:$(HOME)/.local/share/mise/shims:$(HOME)/.cargo/bin:$(HOME)/go/bin:$(HOME)/.dotnet/tools
LOG   = var/log/$(NAME)
PID   = tmp/$(NAME).pid
ALIVE = [ -f $(PID) ] && kill -0 "$$(cat $(PID))" 2>/dev/null

.PHONY: help setup start stop restart status log metrics bench test coverage lint e2e verify
.DEFAULT_GOAL := help

help: ## list the verbs with their usage (default goal)
	@awk -F':.*## ' '/^[a-zA-Z0-9_ -]+:.*## /{printf "  %-12s %s\n", $$1, $$2}' $(firstword $(MAKEFILE_LIST))

# Fresh clone or machine: tools pinned in mise.toml, official installers for a missing uv/bun, then exactly the
# locked deps. Only declared toolchains are touched, so an existing npm/poetry project is never migrated silently.
setup: ## install pinned tools (mise.toml) and exactly the locked dependencies
	@if [ -f mise.toml ] || [ -f .tool-versions ]; then command -v mise >/dev/null 2>&1 || curl -fsSL https://mise.run | sh; mise install; fi
	@if [ -f uv.lock ]; then command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | sh; uv sync --locked; fi
	@if [ -f bun.lock ] || [ -f bun.lockb ]; then command -v bun >/dev/null 2>&1 || curl -fsSL https://bun.sh/install | bash; bun install --frozen-lockfile; fi
	@for d in . server vercel; do npm ci --prefix $$d --no-audit --no-fund || exit 1; done
	@# Browser e2e runs on Playwright's Chromium; Linux CI (CI=true) also needs its system libraries.
	@npx playwright install $${CI:+--with-deps} chromium

# No service (library)? Replace start..log with one line: start stop restart status log: ; @echo "∅ $@: no service"
# Own process group (setsid, else job control) so stop reaps children too; redirected stdio keeps agent shells from hanging.
start: ## run RUN detached: pid in tmp/, stdout|stderr appended to var/log/
	@mkdir -p var/log tmp
	@if $(ALIVE); then echo "running pid=$$(cat $(PID))"; exit 0; fi; \
	[ -n "$$RUN" ] || { echo "UNKNOWN[start] BC RUN unset"; exit 6; }; \
	if command -v setsid >/dev/null 2>&1; then nohup setsid sh -c "$$RUN" >$(LOG).stdout 2>$(LOG).stderr </dev/null & \
	else set -m; nohup sh -c "$$RUN" >$(LOG).stdout 2>$(LOG).stderr </dev/null & set +m; fi; \
	echo $$! >$(PID); sleep 1; \
	if $(ALIVE); then echo "running pid=$$(cat $(PID))"; else echo "dead; see: make log"; exit 1; fi

stop: ## SIGTERM the service group, SIGKILL after 5 s
	@if $(ALIVE); then p=$$(cat $(PID)); kill -s TERM -- -$$p 2>/dev/null || kill -s TERM $$p; \
	i=0; while kill -0 $$p 2>/dev/null && [ $$i -lt 50 ]; do sleep 0.1; i=$$((i+1)); done; \
	kill -s KILL -- -$$p 2>/dev/null || true; fi; rm -f $(PID); echo stopped

restart: stop start ## stop, then start

# LSB codes (make prints them as Error N): 0 running, 1 dead with stale pid, 3 stopped.
status: ## running | dead (stale pid) | stopped, as LSB exit codes
	@if $(ALIVE); then echo "running pid=$$(cat $(PID))"; \
	elif [ -f $(PID) ]; then echo "dead pid=$$(cat $(PID)); see: make log"; exit 1; \
	else echo stopped; exit 3; fi

log: ## tail stdout and stderr logs (N=50 lines)
	@for f in $(LOG).stdout $(LOG).stderr; do [ -f $$f ] && { echo "== $$f"; tail -n $(N) $$f; }; done; \
	ls $(LOG).* >/dev/null 2>&1 || echo "∅ no logs for $(NAME)"

metrics:  ; @echo "UNKNOWN[metrics] BC undefined: print current service|build metrics"; exit 2  ## print current service|build metrics
bench:    ; @echo "UNKNOWN[bench] BC undefined: measure hot paths before perf claims"; exit 2  ## measure hot paths before perf claims

test: ## unit tests of the library, the Express room server and the Vercel functions
	npm test
	npm --prefix server test
	npm --prefix vercel test

# One process per package (--test-isolation=none): with Node 24.14's default process-per-file isolation the merged
# report silently dropped dist/webrtc/*. The library and server are measured on their built dist/ (no type-only lines);
# TOTAL sums lines found|hit over all three lcov files.
COVER = node --test --test-isolation=none --experimental-test-coverage --test-reporter=spec --test-reporter-destination=stdout --test-reporter=lcov
coverage: ## per-file line coverage of the three packages, then TOTAL <n>% over all of them
	@rm -rf coverage && mkdir -p coverage
	npm run build && npm --prefix server run build
	$(COVER) --test-reporter-destination=coverage/lib.lcov --test-coverage-include='dist/**' tests/*.test.mjs
	cd server && $(COVER) --test-reporter-destination=../coverage/server.lcov --test-coverage-include='dist/**' test/*.test.mjs
	cd vercel && $(COVER) --import tsx --test-reporter-destination=../coverage/vercel.lcov --test-coverage-include='src/**' --test-coverage-include='api/**' test/*.test.ts
	@awk -F: '/^LF:/{f+=$$2} /^LH:/{h+=$$2} END{if(!f){print "UNKNOWN[coverage] BC no lcov lines"; exit 2} printf "TOTAL %.2f%%\n", 100*h/f}' coverage/*.lcov

# The vercel package runs its tests through tsx, which strips types without checking them; root and server type-check in their builds.
lint: ## oxlint (warnings fail) + type check of the vercel package
	npx --yes oxlint@1.84.0 --deny-warnings
	npm --prefix vercel run check

e2e: ## packed tarball in a clean consumer, protocol suite against the built server, chat app in real Chromium; reports in output/
	@mkdir -p output/e2e
	npm --prefix server run build
	node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=output/e2e/node.xml e2e/*.test.mjs
	npm run test:browser

# What CI runs; the gate runs the same verbs one by one and fails while verify skips any. Fail-fast order: cheapest first.
verify: lint test coverage e2e ## what CI runs: every gate verb, cheapest first
