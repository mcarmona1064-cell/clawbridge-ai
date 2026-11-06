# Central slash commands + host terminal approval implementation plan

> **For Hermes:** Implement with strict TDD, minimal scope, and verify before commit/push.

**Goal:** Make ClawBridge use a single source of truth for slash command behavior and add messaging-channel approval for sensitive host terminal execution (`host_exec`).

**Architecture:** Add a shared TypeScript command registry consumed by both host and container runner. Add a host-exec approval flow that sends an approval card to an owner/admin over the existing messaging channel before running dangerous host commands, then writes the command result back to the waiting container response file.

**Tech Stack:** TypeScript, pnpm, Vitest, SQLite-backed sessions/approvals, existing delivery adapter and approval primitive.

---

## Task 1 — Central slash command registry

**Objective:** Create one shared host/container command registry modeled after Hermes `COMMAND_REGISTRY` so command lists no longer drift.

**Files:**
- Create: `src/shared/commands.ts`
- Modify: `src/command-gate.ts`
- Modify: `container/agent-runner/src/formatter.ts`
- Test: `src/command-gate.test.ts`
- Test: existing/new runner formatter/poll-loop tests

**Plan:**
1. Write failing tests for command classification, especially `/clearfoo` not matching `/clear`.
2. Create `shared/commands.ts` exporting:
   - `CommandCategory = 'admin' | 'filtered' | 'passthrough' | 'none'`
   - command definitions for `/help`, `/login`, `/logout`, `/doctor`, `/config`, `/remote-control`, `/start`, `/clear`, `/compact`, `/context`, `/cost`, `/files`
   - `extractSlashCommand(text)` tokenizes only the first whitespace-delimited token.
   - `classifySlashCommand(text)` returns category and command.
   - `isCommand(text, command)` exact-token helper for runner-local `/clear`.
3. Update host `gateCommand()` to call registry classification.
4. Update container formatter `categorizeMessage()` and `isClearCommand()` to call registry helpers.
5. Run focused tests, then full tests.

**Acceptance criteria:**
- `/clear` and `/clear anything` clear the runner session.
- `/clearfoo` is an unknown passthrough command and does not clear.
- Host and container command categories come from the same file.
- Existing filtered/admin behavior remains compatible, with `/start` filtered consistently.

---

## Task 2 — Host-exec approval notifications over messaging

**Objective:** Before running dangerous host terminal commands requested via `host_exec`, notify an owner/admin through the existing approval-card system and run the command only after approval.

**Files:**
- Modify: `src/modules/host-exec/index.ts`
- Possibly modify: `src/modules/approvals/response-handler.ts` only if reject path must write a response to waiting tool call
- Test: new `src/modules/host-exec/index.test.ts`

**Plan:**
1. Add a conservative dangerous-command classifier in host-exec:
   - dangerous examples: `sudo`, `rm -rf`, `launchctl`, `systemctl`, `kill`, `pkill`, `docker stop/rm`, `git reset --hard`, `git clean`, package installs, shell scripts via `curl | sh`.
   - non-dangerous examples: `pwd`, `ls`, `git status`, `date`, simple reads.
2. If `allowHostExec` is false: existing permission-denied response unchanged.
3. If command is safe: execute immediately as today.
4. If command is dangerous:
   - unlink request before action as today to avoid replay loops.
   - create a pending approval with action `host_exec` using existing `requestApproval()`.
   - payload includes request id, response path, command, cwd, and timeout.
   - approval card title: `Approve host terminal command?`
   - question includes agent/session, cwd, timeout, and command in a code block.
   - do not run command yet.
5. Register an approval handler for `host_exec` in the host-exec module:
   - on approve, execute command and write response JSON to the stored response path.
   - notify the agent that the command was approved and executed.
6. Ensure rejection writes a response JSON too, so the waiting `host_exec` tool returns a clear denial instead of timing out. Prefer extending approval handler context with selected option only if necessary and backwards-compatible.
7. Add tests for safe immediate execution, dangerous approval request, approved execution writes response, rejected command writes denial response, allowHostExec false remains denied.

**Acceptance criteria:**
- Dangerous host-exec commands produce a messaging approval card to an eligible admin/owner.
- Approved command runs and returns stdout/stderr/exit code to the waiting container tool.
- Rejected command returns an explicit denied response to the tool; no timeout.
- Safe commands still work without approval.
- No replay loop risk: request files are unlinked before command/approval.

---

## Task 3 — Verification, commit, push

**Commands:**
- `pnpm test -- src/command-gate.test.ts`
- Focused runner/host-exec tests as added.
- `pnpm test`
- `pnpm typecheck`
- `pnpm build`
- `git diff --check`
- `git status --short`

**Commit/push:**
- Commit message: `feat: centralize commands and approve host exec`
- Push: `git push origin main`

---

## Review section

Implemented and verified.

**Summary:**
- Added `src/shared/commands.ts` as the shared slash-command registry used by host `gateCommand()` and the container runner formatter.
- Mounted `src/shared` read-only into agent containers at `/shared` so the runner import resolves inside the container.
- Added exact-token slash-command behavior so `/clearfoo`/`/startnow` remain unknown passthrough commands.
- Added host-exec dangerous-command classification and approval-card flow for sensitive host terminal requests.
- Added approval rejection handlers so rejected `host_exec` requests write an explicit denial response instead of timing out.

**Verification:**
- `pnpm typecheck` passed.
- `pnpm test` passed: 30 files, 240 tests.
- `pnpm build` passed.
- `git diff --check` passed.

---

# Dual provider: Claude + Codex in one install (branch `feat/dual-provider`)

**Goal:** Any agent group or session can run on Claude (Claude Agent SDK + Claude Code) or Codex, in one image, switchable at runtime.

- [x] Container: ship both providers (`providers/claude.ts` ported from clawbridge-agent, `@anthropic-ai/claude-agent-sdk` + lockfile, Dockerfile installs both CLIs behind `INSTALL_CLAUDE` / `INSTALL_CODEX`).
- [x] Runner reads the host-resolved provider from `CLAWBRIDGE_PROVIDER` (previously per-session/group overrides never reached the container).
- [x] Host: `src/providers/claude.ts` (settings.json + credential, OAuth preferred over API key), `providers/state-dir.ts` (`.claude-shared` / `.codex-shared` per provider), composed instructions mounted as both `AGENTS.md` and `CLAUDE.md`, duplicate `.codex` mount removed.
- [x] Install default via `DEFAULT_AGENT_PROVIDER`; `AGENT_PROVIDER` stays a legacy migration marker.
- [x] `/provider` host command (show / group / session / default) + provider line in `/status`.
- [x] Host LLM calls (`extractor`, `reflection-agent`, `cross-client`, `error-handler`) go through `host-llm.ts` → `codex exec` or `claude -p`.
- [x] Setup wizard: choose providers + default, Claude auth (`claude setup-token` or paste); doctor/verify/probe check each enabled provider; clawbridge-agent migration keeps Claude as the default.
- [x] Tests: `codex-port.test.ts` → `provider-port.test.ts` (dual-provider invariants), new `host-llm.test.ts`, `host-commands/provider.test.ts`, migration carry-over test, Claude factory test.

## Review

- Host: `tsc` clean; vitest 250/252 pass. The 2 failures (`memory/hindsight.test.ts`) also fail on the base commit.
- Runner: `bun install --frozen-lockfile` accepts the lockfile; `bun test` 23 pass / 6 fail. The same 6 fail on the base commit (missing `/shared` mount outside the container, session-state tests). The new Claude factory test passes.
- Lint: 33 errors vs 34 on base, none in changed files.
- **Not verified:** `docker build` of the image and a live Claude/Codex round-trip (no Docker on the dev machine). Hindsight's own LLM still uses `openai-codex`, so a Claude-only install needs Hindsight pointed at another LLM.
