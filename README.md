<p align="center">
  <img src="assets/clawbridge-logo.png" alt="ClawBridge" width="400">
</p>

<h1 align="center">ClawBridge AI</h1>

<p align="center">
  A self-hosted AI coworker for your whole team, in Slack and every other channel, powered by Claude or OpenAI Codex.
</p>

<p align="center">
  <a href="https://clawbridge.dev">clawbridge.dev</a>&nbsp; • &nbsp;
  <a href="https://docs.clawbridge.dev">docs</a>&nbsp; • &nbsp;
  <a href="README_zh.md">中文</a>&nbsp; • &nbsp;
  <a href="README_ja.md">日本語</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="repo tokens" valign="middle"></a>
</p>

---

## Built by Mark Carmona

ClawBridge Codex is an open-source AI agent platform designed and maintained by [Mark Carmona](https://markcarmona.online/), an AI Automation & AI Agent Engineer in the Philippines specializing in self-hosted agents, OpenClaw, multi-agent orchestration, and workflow automation.

The project includes public TypeScript source, Docker-based agent isolation, OpenAI Codex integration, Hindsight memory, multi-channel adapters, health-check tooling, release history, and architecture documentation.

- [Project case study](https://markcarmona.online/projects/clawbridge-ai/)
- [About Mark Carmona](https://markcarmona.online/about/mark-carmona/)

## Why I Built ClawBridge

[OpenClaw](https://github.com/openclaw/openclaw) is an impressive project, but I wouldn't have been able to sleep if I had given complex software I didn't understand full access to my life. OpenClaw has nearly half a million lines of code, 53 config files, and 70+ dependencies. Its security is at the application level rather than true OS-level isolation.

ClawBridge keeps the useful parts — message routing, persistent context, channels, tools, and scheduled work — while staying small enough to understand. Codex agents run in isolated Linux containers with explicit filesystem mounts.

## Quick Start

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/mcarmona1064-cell/clawbridge-ai/main/clawbridge.sh)
```

One command checks/install prerequisites where supported, then launches the interactive setup wizard.

If you already have Node 22+ installed:

```bash
npx github:mcarmona1064-cell/clawbridge-ai
```

The repository is private: either command needs your GitHub sign-in, through `gh auth login` or a git credential helper. Without one, clone it first:

```bash
gh repo clone mcarmona1064-cell/clawbridge-ai && bash clawbridge-ai/clawbridge.sh
```

After setup, everything else happens in chat. `/help` lists the commands, and `/connect` adds a channel.

If installed globally:

```bash
clawbridge-ai
```

### Upgrading from ClawBridge or ClawBridge Codex

Your agents, conversations, schedules and settings carry over. Run the new CLI and pick **Upgrade from ClawBridge or ClawBridge Codex** (setup suggests it when it finds an old install), or run it directly:

```bash
clawbridge-ai migrate --dry-run
```

```bash
clawbridge-ai migrate
```

The upgrade:

- stops the old service and checks it really stopped, so the two versions never answer the same bots;
- backs up `.env`, every database and each agent's instruction files to `~/.clawbridge/upgrade-backup/`;
- keeps your agents on the provider they used (Codex or Claude), and offers to turn on the other one;
- moves agents with extra packages onto the new image (rebuilt the first time each one runs);
- repoints `~/.clawbridge` at the new package, then builds the new agent image and starts the new service.

Every `.env` setting is kept. Installs that ran from a source checkout are copied into `~/.clawbridge`, and the checkout is left as it was. If the service ever needs registering again, run `clawbridge-ai service install`.

`clawbridge-ai migrate --rollback` undoes the upgrade and starts the old service again. ClawBridge AI is stopped first, and what it had (chats since the upgrade, settings) is kept in the backup folder rather than deleted.

Memories saved before memory became per-conversation (the `client-global` Hindsight bank) are kept but no longer recalled. Re-add anything the whole team should know with `/teamfact`.

To migrate from an existing OpenClaw or NanoClaw install, choose **Migrate from OpenClaw** in the setup wizard, or run `clawbridge-ai migrate --openclaw`.

---

## Features

- 💬 **One agent on every channel.** Slack, WhatsApp (official Cloud API), Telegram and Discord are first-class, with buttons, threads, formatting and files native to each. Teams, Google Chat, Webex, Matrix, Signal, iMessage and email are added through skills. See [docs/channels.md](docs/channels.md).
- 🪄 **Set up in minutes, then never touch a terminal.**
  - `clawbridge-ai` walks you through each channel and checks every credential.
  - After that, `/connect`, `/onboard`, `/reply`, `/digest` and `/help` run everything from chat.
- 🤖 **Claude and Codex in one install.** Switch with `/provider`, and choose how hard the agent thinks with `!fast`, `!deep` or `/model`.
- 🔐 **Subscriptions, and keys on the host.**
  - Sign in with `claude setup-token` and `codex login --device-auth`.
  - The credential proxy gives containers placeholders only. `EGRESS_LOCKDOWN` makes the proxy their only way out.
- 🧠 **Memory per conversation, plus team knowledge.** Team facts need an admin's approval. `/memory` shows, searches and forgets.
- 🧩 **Your business apps.**
  - GitHub, Linear, Jira, Notion, HubSpot, Stripe, Shopify, Gmail, Google Calendar, Drive, Sheets and custom APIs.
  - Reads run directly. Changes need approval first, are idempotent, and come back with evidence. See [docs/integrations.md](docs/integrations.md).
- ✅ **Approvals people trust.**
  - Risk badges, scoped "Always allow" and `/permissions`.
  - Approver and auditor roles.
  - Approvals arrive in the chat you choose (`/notify-here`), even across apps once your accounts are linked with `/link`.
- 🙅 **Honest by design.**
  - Replies that claim things that didn't happen get corrected.
  - Private-chat content needs approval before it reaches a group.
  - Every security-relevant action goes into a hash-chained audit log.
- 💸 **No surprise bills.** `/usage`, monthly budgets with alerts at 50/75/90/100%, and frequent jobs gated by condition scripts.
- 📊 **Real work.** Data questions over your files (`query_data`), shareable report links, a browser you can take over for sign-ins, voice replies, and skills pinned to reviewed commits.
- 🧪 **Checked every night.** A channel contract suite, plus an eval suite run on both providers (pass^3).

## Architecture

```
messaging apps → host process (router) → inbound.db → container (Bun, Claude or Codex) → outbound.db → host process (delivery) → messaging apps
```

A single Node host orchestrates per-session agent containers. Agents run in Docker with explicit filesystem mounts. Each provider keeps its own per-agent-group state directory (`.claude-shared` → `/home/node/.claude`, `.codex-shared` → `/home/node/.codex`). Codex auth is copied from host `~/.codex/auth.json`; the Claude token is passed only to Claude containers; channel tokens and host-only settings live in `~/.clawbridge/.env`. See [docs/architecture.md](docs/architecture.md) for the full writeup.

## AI Providers

ClawBridge ships both providers in one agent image, so any agent can run on either:

| Provider | Runtime in the container                         | Sign-in                                                                    |
| -------- | ------------------------------------------------ | -------------------------------------------------------------------------- |
| `claude` | Claude Agent SDK driving Claude Code             | `claude setup-token` (your Claude subscription), or an `ANTHROPIC_API_KEY` |
| `codex`  | `codex exec --json` / `codex exec resume --json` | `codex login --device-auth` (ChatGPT subscription)                         |

Setup asks which providers to enable and which one is the default (`DEFAULT_AGENT_PROVIDER` in `~/.clawbridge/.env`). The provider for each run is resolved in this order:

1. the session override (`/provider claude session`)
2. the agent group setting (`/provider codex`)
3. `"provider"` in the group's `container.json`
4. `DEFAULT_AGENT_PROVIDER`

`/provider` with no arguments shows the current provider and where it comes from; `/provider default` clears the overrides. Switching stops the running agent so the next message starts it on the new provider. Each provider resumes its own conversation history.

Both CLIs read the same composed instructions: the host mounts one file as both `AGENTS.md` and `CLAUDE.md`. Per-group persona and notes live in `AGENTS.local.md`.

The Codex subprocess strips `OPENAI_API_KEY`, `CODEX_API_KEY`, and `OPENAI_BASE_URL` so it stays on subscription OAuth. For Claude, a subscription token wins over an API key, and only one is passed in. Note: Anthropic's Agent SDK terms say products built on the SDK should not offer claude.ai login to their users — fine for your own install on your own subscription; use API keys for installs you run for clients.

Host-side helper calls (memory extraction, reflection, error diagnosis) go through the CLI of `HOST_LLM_PROVIDER` (defaults to `DEFAULT_AGENT_PROVIDER`). To build a smaller image with only one CLI, set `INSTALL_CLAUDE=false` or `INSTALL_CODEX=false` when running `container/build.sh`.

## Setup, health checks, and upgrades

Setup is interactive by default:

```bash
clawbridge-ai
```

During setup ClawBridge:

- verifies Docker and Node
- installs `@openai/codex` if missing
- authenticates Codex with `codex login --device-auth`
- creates `~/.clawbridge/.env`
- links `~/.clawbridge/docker-compose.yml` to the installed package so upgrades pick up compose changes
- optionally enables Hindsight semantic memory
- builds the agent container image
- starts the background service with launchd on macOS or systemd on Linux
- verifies the service, agent, and selected channel

Run a health check any time:

```bash
clawbridge-ai doctor
```

Run auto-fix mode for repairable problems:

```bash
clawbridge-ai doctor --fix
```

`doctor --fix` can restart the background service, start Hindsight containers, rebuild a missing agent image, recreate the docker-compose symlink, restart channel connections, and normalize Hindsight model settings.

Upgrade to the latest release:

```bash
clawbridge-ai upgrade
# or
clawbridge-ai update
```

Upgrade checks npm for the latest version, stops the running service, installs the latest `clawbridge-ai` package, refreshes the compose symlink, rebuilds the agent image, restarts the service, and runs `doctor`. Your `~/.clawbridge` data, conversations, and memories are preserved.

## Memory and Hindsight

Every agent group has persistent files, including `AGENTS.local.md`, Codex session state, and conversation history. For semantic memory, setup can enable Hindsight. Hindsight runs as host-side Docker services (`hindsight-api` and `hindsight-db`), not inside the agent container. The host retrieves memory and injects relevant context into each agent turn.

If Hindsight is configured, `clawbridge-ai doctor` checks the containers and `/health`; `doctor --fix` can start the containers and normalize Hindsight to the `openai-codex` provider. Hindsight reads OpenAI Codex OAuth from `~/.codex/auth.json` via a read-only Docker mount, so retain/recall/reflect use the same Codex subscription auth path as the agent instead of `OPENAI_API_KEY` billing.

## Philosophy

**Small enough to understand.** One process, a few source files, and no microservices. If you want to understand the full ClawBridge codebase, ask Codex to walk you through it.

**Secure by isolation.** Agents run in Linux containers and can only see what is explicitly mounted. Bash access is safe because commands run inside the container, not on your host.

**Built for the individual user.** ClawBridge is designed to be bespoke. You can fork it and have Codex modify it to match your exact workflow.

**Customization = code changes.** No configuration sprawl. Want different behavior? Modify the code. The codebase is small enough that changes are reviewable.

**Best harness, best model.** ClawBridge natively uses the OpenAI Codex CLI via subscription OAuth, so you get GPT models and Codex's toolset, including the ability to modify and expand your own ClawBridge fork.

## What It Supports

- **Multi-channel messaging** — WhatsApp, Telegram, Discord, Slack, Microsoft Teams, Matrix, Google Chat, Webex, Linear, GitHub, WeChat, and email via Resend
- **Flexible isolation** — connect each channel to its own agent, share one agent across many channels, or fold multiple channels into a single shared session
- **Per-agent workspace** — each agent group has its own persona, memory, container, and allowed mounts
- **Scheduled tasks** — recurring jobs that run Codex and can message you back
- **Web access** — search and fetch content from the web
- **Container isolation** — agents are sandboxed in Docker, with optional Docker Sandboxes or Apple Container support
- **Credential security** — Codex uses subscription OAuth from `~/.codex/auth.json`; channel credentials remain host-side in `~/.clawbridge/.env`; Hindsight credentials are not passed into agent containers

## Usage

Talk to your assistant with the trigger word (default: `@Andy`):

```
@Andy send an overview of the sales pipeline every weekday morning at 9am
@Andy review the git history for the past week each Friday and update the README if there's drift
@Andy every Monday at 8am, compile news on AI developments from Hacker News and TechCrunch and message me a briefing
```

From a channel you own or administer, you can manage groups and tasks:

```
@Andy list all scheduled tasks across groups
@Andy pause the Monday briefing task
@Andy join the Family Chat group
```

## Customizing

Edit `~/.clawbridge/groups/main/AGENTS.local.md` to customize your agent's persona. The file is created with a default template on first run.

You can change:

- agent name and personality
- background knowledge about you or your team
- behavioral preferences and response style

For code-level changes, ask Codex from your checkout or use `/customize` if that skill is installed.

## Requirements

- macOS, Linux, or Windows via WSL2
- Node.js 20+; pnpm is only needed for local development from a checkout
- Docker Desktop on macOS/Windows, or Docker Engine on Linux
- [Codex CLI](https://github.com/openai/codex) — setup installs it if missing and authenticates with `codex login --device-auth`

## Key Files

- `src/index.ts` — entry point: DB init, channel adapters, delivery polls, sweep
- `src/router.ts` — inbound routing: messaging group → agent group → session → `inbound.db`
- `src/delivery.ts` — polls `outbound.db`, delivers via adapter, handles system actions
- `src/host-sweep.ts` — 60s sweep: stale detection, due-message wake, recurrence
- `src/session-manager.ts` — resolves sessions, opens `inbound.db` / `outbound.db`
- `src/container-runner.ts` — spawns per-agent-group Codex containers
- `src/providers/` — host-side provider config; Codex is built in
- `src/db/` — central DB: users, roles, agent groups, messaging groups, wiring, migrations
- `src/channels/` — channel adapter infra
- `container/agent-runner/` — Bun runner: poll loop, MCP tools, provider abstraction
- `container/Dockerfile` — Codex container image
- `groups/<folder>/` — per-agent-group filesystem: persona, memory, skills, container config

## FAQ

**Why Docker?**

Docker provides cross-platform support and a mature ecosystem. On macOS, you can optionally switch to Apple Container via `/convert-to-apple-container` for a lighter-weight native runtime.

**Can I run this on Linux or Windows?**

Yes. ClawBridge runs on macOS and Linux VPS hosts. Windows via WSL2 also works.

**Is this secure?**

Agents run in containers, not behind application-level permission checks. They can only access explicitly mounted directories. Host-side Hindsight and channel credentials do not get passed into agent containers.

**Do I need to pay per message?**

No for the agent runtime. ClawBridge uses Codex subscription OAuth, not API-key billing, for agent execution.

**Can I use third-party or open-source models?**

Yes. Use `/add-ollama-provider` for local open-weight models via Ollama.

**How do I debug issues?**

Start with:

```bash
clawbridge-ai doctor
clawbridge-ai doctor --fix
```

Doctor checks Docker, the background service, Codex auth, Hindsight, channels, storage, and the agent image. If a check still fails, inspect logs under `~/.clawbridge/logs/`.

**Why isn't setup working for me?**

Re-run setup after fixing the reported prerequisite, or run `clawbridge-ai doctor --fix` for repairable issues. Common fixes are starting Docker Desktop, re-running `codex login --device-auth`, or restarting the launchd/systemd service.

## Contributing

Security fixes, bug fixes, and clear improvements are welcome. Larger capabilities should be contributed as skills or maintained in a fork.

## Community

Questions? Ideas? [Join the Discord](https://discord.gg/VDdww8qS42).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for breaking changes, or the [full release history](https://docs.clawbridge.dev/changelog) on the documentation site.

## License

MIT
