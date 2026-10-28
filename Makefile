SHELL := bash

# Two kinds of targets:
# - hermetic ones (check, package) go through nix-build (nix/default.nix), in the Nix sandbox;
# - the development loop (test, e2e, run, …) runs inside the nix shell (shell.nix). --pure keeps host
#   libraries out of Chromium's way. Already inside `nix-shell`? Then the commands run directly.
ifdef IN_NIX_SHELL
RUN := bash -c
else
RUN := nix-shell --pure shell.nix --run
endif
NIX_BUILD := nix-build --max-jobs auto

# The backend and the SDK come from e2ee-store, as pinned in nix/e2ee-store.nix (`make deps` builds them). To
# work on e2ee-store at the same time, point these at its checkout instead, e.g.
#   make run BACKEND=../e2ee-store/backend/target/debug/backend SDK=../e2ee-store/sdk/src
# (after `make -C ../e2ee-store build`).
DEFAULT_BACKEND := data/backend/bin/backend
DEFAULT_SDK := data/sdk/share/e2ee-store/sdk
BACKEND ?= $(DEFAULT_BACKEND)
SDK ?= $(DEFAULT_SDK)
PORT ?= 8081

.PHONY: all check package deps test test-web e2e run iroh user setup-token

# Everything, hermetic: both packages, the frontend's unit tests, the browser test, the VM test, and the e2ee-store
# checks this repository reruns (its SDK's tests and its S3 VM test), in the Nix sandbox. This is what CI runs.
all: check

check:
	$(NIX_BUILD) nix --no-out-link

# Just the packages (building the backend still runs the Rust suite). result/ and result-2/ link to them.
package:
	$(NIX_BUILD) nix -A backend -A web

# The backend at data/backend and the SDK at data/sdk, built by Nix; web/public/sdk links to the SDK, so the
# backend serves web/public as it is.
deps:
ifeq ($(BACKEND),$(DEFAULT_BACKEND))
	$(NIX_BUILD) nix -A backend -o data/backend
endif
ifeq ($(SDK),$(DEFAULT_SDK))
	$(NIX_BUILD) nix -A sdk -o data/sdk
endif
	ln -sfn $(abspath $(SDK)) web/public/sdk

# ---------------------------------------------------------------- development loop (incremental, dev shell)

test: test-web

test-web: deps
	$(RUN) 'node --test "web/test/unit/**/*.test.js"'

# The real backend behind socat, driven by Chromium with a PRF-capable virtual authenticator (e2ee-store's
# harness, next to the SDK).
E2E_ENV := BACKEND_BIN=$(BACKEND) PYTHONPATH=$(abspath $(SDK)/../testing)
e2e: deps
	$(RUN) 'for test in playback upload library; do $(E2E_ENV) python3 web/test/e2e/test_$$test.py || exit 1; done'

# Local development: the backend on ./data/backend.sock (config.toml), reachable at
# http://localhost:$(PORT) through socat, the way the iroh shim reaches it.
run: deps
	$(RUN) 'BACKEND=$(BACKEND) dev/run.sh $(PORT)'

# Exposes ./data/backend.sock over iroh for the Android app; run it next to `make run`. Prints the
# ticket to paste into the app.
iroh:
	nix-build nix/iroh-ssh.nix -o data/iroh-ssh
	dev/iroh.sh

# make user NAME=alice — prints a setup token; open http://localhost:$(PORT)/#setup=<token>
user: deps
	$(RUN) '$(BACKEND) user create $(NAME)'

# make setup-token NAME=alice — a new token for an existing user (e.g. a second device)
setup-token: deps
	$(RUN) '$(BACKEND) setup-token create $(NAME)'
