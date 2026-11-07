# ClawBridge Security Model

## Trust Model

| Entity | Trust Level | Rationale |
|--------|-------------|-----------|
| Main group | Trusted | Private self-chat, admin control |
| Non-main groups | Untrusted | Other users may be malicious |
| Container agents | Sandboxed | Isolated execution environment |
| Incoming messages | User input | Potential prompt injection |

## Security Boundaries

### 1. Container Isolation (Primary Boundary)

Agents execute in containers (lightweight Linux VMs), providing:
- **Process isolation** - Container processes cannot affect the host
- **Filesystem isolation** - Only explicitly mounted directories are visible
- **Non-root execution** - Runs as unprivileged `node` user (uid 1000)
- **Ephemeral containers** - Fresh environment per invocation (`--rm`)
- **Hardening flags** - `--cap-drop ALL`, `--security-opt no-new-privileges`, a PID limit (1024) and a memory limit (4g) by default (`containerHardeningArgs()` in `src/container-runner.ts`; tune with `CONTAINER_MEMORY`, `CONTAINER_PIDS_LIMIT`, `CONTAINER_CPUS`, or disable with `CONTAINER_HARDENING=off`)

This is the primary security boundary. Rather than relying on application-level permission checks, the attack surface is limited by what's mounted.

### 2. Mount Security

**External Allowlist** - Mount permissions stored at `~/.config/clawbridge/mount-allowlist.json`, which is:
- Outside project root
- Never mounted into containers
- Cannot be modified by agents

**Default Blocked Patterns:**
```
.ssh, .gnupg, .aws, .azure, .gcloud, .kube, .docker,
credentials, .env, .netrc, .npmrc, id_rsa, id_ed25519,
private_key, .secret
```

**Protections:**
- Symlink resolution before validation (prevents traversal attacks)
- Container path validation (rejects `..` and absolute paths)
- `nonMainReadOnly` option forces read-only for non-main groups

**Read-Only Project Root:**

The main group's project root is mounted read-only. Writable paths the agent needs (store, group folder, IPC, `.claude/`) are mounted separately. This prevents the agent from modifying host application code (`src/`, `dist/`, `package.json`, etc.) which would bypass the sandbox entirely on next restart. The `store/` directory is mounted read-write so the main agent can access the SQLite database directly.

### 3. Session and Memory Isolation

Each agent group keeps its provider CLI state per provider at `data/v2-sessions/{agentGroupId}/.claude-shared/` (mounted at `/home/node/.claude`) or `.codex-shared/` (mounted at `/home/node/.codex`):
- Groups cannot see other groups' conversation history
- A DM never joins an `agent-shared` session, so a private conversation is never in another chat's live context

Long-term memory (Hindsight) has one bank per conversation, so a DM's memories can never be recalled in another chat. The only shared bank is the agent group's team bank, which takes facts only after an admin approves them. See `docs/hindsight.md`.

### 4. IPC Authorization

Messages and task operations are verified against group identity:

| Operation | Main Group | Non-Main Group |
|-----------|------------|----------------|
| Send message to own chat | ✓ | ✓ |
| Send message to other chats | ✓ | ✗ |
| Schedule task for self | ✓ | ✓ |
| Schedule task for others | ✓ | ✗ |
| View all tasks | ✓ | Own only |
| Manage other groups | ✓ | ✗ |

### 5. Credentials

**What reaches a container.** Provider credentials reach a container in one of two ways.

- **Credential proxy (recommended):** set `CREDENTIAL_PROXY=on` in `~/.clawbridge/.env`.
  - The real Claude credential (subscription token or API key) stays in the host process.
  - Each container gets a per-session placeholder (`cbp_…`), with `ANTHROPIC_BASE_URL` pointing at the host proxy (`src/credential-proxy.ts`).
  - The proxy accepts a placeholder only for the API it was issued for, swaps in the real credential, and streams the reply.
  - Placeholders are revoked when the container exits. A copied placeholder is useless anywhere else.
- **Verified so far:** Claude Code inside a container sends the placeholder to the proxy as `Authorization: Bearer cbp_…`, after an unauthenticated `HEAD /api/hello` probe that the proxy lets through. The full round trip to Anthropic with a real token has not been tested yet.
- **Direct (when `CREDENTIAL_PROXY` is unset):** the credential is passed with `-e` to `docker run`, so code the agent runs can read it.
  - **Claude:** the subscription token (`CLAUDE_CODE_OAUTH_TOKEN`) or `ANTHROPIC_API_KEY` from `~/.clawbridge/.env`.
- **Codex** (either way): `~/.codex/auth.json`, including its refresh token, is copied into the group's `.codex-shared/` state dir at every spawn.
  - By default it is writable at `/home/node/.codex/auth.json`, because Codex rewrites it when it refreshes tokens.
  - `CODEX_AUTH_READONLY=on` mounts it read-only, so code in the container can't overwrite or plant credentials. Keep `codex` signed in on the host: the host copy is re-synced on every spawn.
  - Each group gets its own copy; the host's own file is never mounted.

**Outbound traffic.** With `EGRESS_PROXY=on`, every other HTTPS request from a container goes through the same host proxy (`HTTPS_PROXY`, CONNECT tunnels authenticated by the session placeholder).
- The proxy refuses private, loopback, link-local and cloud-metadata addresses (for example `169.254.169.254` and the host's LAN).
- With `EGRESS_ALLOWLIST=github.com,pypi.org,…` set, it refuses any other host.
- Refusals are written to the audit log (`egress.blocked`).
- **Limit:** without lockdown, a process inside the container that ignores `HTTPS_PROXY` can still open direct connections.
- **Network lockdown.** `EGRESS_LOCKDOWN=on` closes that gap.
  - Agent containers run on an internal Docker network (`clawbridge-egress`) with no route out.
  - The only exit is a tiny relay container (`egress`) that forwards to the host proxy and holds no credentials.
  - Lockdown turns the egress proxy on.
  - Services on the host that containers used directly (such as a local Ollama) must then be reached through the proxy, or stay unlocked.

**What never reaches a container:**
- `~/.clawbridge/.env` itself, channel tokens (Slack, Telegram, …), Hindsight credentials, and the integration server's secrets — host only
- Channel auth sessions (`store/auth/`) — host only
- The mount allowlist — external, never mounted
- Anything matching the blocked mount patterns above
- Scheduled-task pre-scripts run with provider credentials and other `*_API_KEY` / `*_TOKEN` / `*_SECRET` variables stripped from their environment

**Known limitations:**
- Without `CREDENTIAL_PROXY=on`, a prompt-injected agent could read the Claude credential and send it elsewhere.
- The Codex `auth.json` is readable inside the container in every mode, and writable unless `CODEX_AUTH_READONLY=on`.
- Use a dedicated key or subscription seat for ClawBridge, and rotate it if an agent may have been compromised.

### 6. Host Commands (`host_exec`)

`host_exec` lets an agent run a shell command **on the host**. It is off unless the agent group's `container.json` sets `allowHostExec: true`. When on:
- Only single, simple, read-only commands on an allowlist (`pwd`, `ls`, `date`, `df`, `git status/log/diff`, …) run without approval.
- Everything else — shell operators, substitutions, redirects, interpreters such as `python -c`, any other program, and any path into `.clawbridge`, `.env`, `.ssh`, `.codex`, `.claude` or `.aws` — waits for an admin's approval.
- The working directory must be an existing absolute path outside those locations.

### 7. Approvals

Approval cards (package installs, MCP servers, `host_exec`, team memory, …) can only be decided by an owner or admin of the agent group; other clicks are logged and ignored. Each request expires (`APPROVAL_TTL_HOURS`, default 24), and decided requests are kept with who decided and when.

## Privilege Comparison

| Capability | Main Group | Non-Main Group |
|------------|------------|----------------|
| Project root access | `/workspace/project` (ro) | None |
| Store (SQLite DB) | `/workspace/project/store` (rw) | None |
| Group folder | `/workspace/group` (rw) | `/workspace/group` (rw) |
| Global memory | Implicit via project | `/workspace/global` (ro) |
| Additional mounts | Configurable | Read-only unless allowed |
| Network access | Unrestricted (see Known limitation) | Unrestricted (see Known limitation) |
| MCP tools | All | All |

## Security Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        UNTRUSTED ZONE                             │
│  Incoming Messages (potentially malicious)                         │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Trigger check, input escaping
┌──────────────────────────────────────────────────────────────────┐
│                     HOST PROCESS (TRUSTED)                        │
│  • Message routing                                                │
│  • IPC authorization                                              │
│  • Mount validation (external allowlist)                          │
│  • Container lifecycle                                            │
│  • Credential injection from ~/.clawbridge/.env at spawn time    │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Explicit mounts; provider credential only
┌──────────────────────────────────────────────────────────────────┐
│                CONTAINER (ISOLATED/SANDBOXED)                     │
│  • Agent execution                                                │
│  • Bash commands (sandboxed)                                      │
│  • File operations (limited to mounts)                            │
│  • API calls go directly to upstream services                    │
│  • Holds the provider credential (env / Codex auth.json) — see §5│
└──────────────────────────────────────────────────────────────────┘
```

## Supply Chain Security (pnpm)

ClawBridge uses pnpm with two supply chain defenses configured in `pnpm-workspace.yaml`:

### Minimum Release Age

`minimumReleaseAge: 4320` (3 days). pnpm will refuse to resolve any package version published less than 3 days ago. This defends against typosquatting and compromised maintainer accounts — most malicious publishes are detected and pulled within 72 hours.

**Excluding a package from the release age gate** (`minimumReleaseAgeExclude`):

This should be rare. When a zero-day fix or critical dependency requires an immediate update:

1. The exclusion must be reviewed and approved by a human maintainer
2. The entry must pin the **exact version** being excluded — never a range or wildcard
   ```yaml
   minimumReleaseAgeExclude:
     some-package: "1.2.3"  # Approved by @user, 2026-04-14 — CVE-XXXX-YYYY fix
   ```
3. The exclusion should be removed once the version ages past the threshold (i.e. after 3 days)
4. Automated agents (Codex, CI bots) must never add exclusions without human sign-off

### Build Script Allowlist

`onlyBuiltDependencies` restricts which packages can execute install/postinstall scripts. Only packages on this list are permitted to run build scripts during `pnpm install`. Currently allowed:

- `better-sqlite3` — compiles native SQLite bindings
- `esbuild` — downloads platform-specific binary
- `protobufjs` — generates protobuf bindings (used by Baileys/libsignal)
- `sharp` — downloads platform-specific image processing binary

Adding a package to this list requires human approval — build scripts execute arbitrary code with the installing user's permissions.

### `.npmrc` Safety Net

The `.npmrc` file contains `minReleaseAge=3d` as a fallback. The authoritative setting is in `pnpm-workspace.yaml`, but `.npmrc` provides defense-in-depth if npm is ever invoked directly (e.g. by a tool that doesn't respect pnpm).
