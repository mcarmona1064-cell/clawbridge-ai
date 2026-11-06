# Hindsight — Semantic Memory

## What is Hindsight?

Hindsight is a self-hosted semantic memory layer built on [vectorize-io/hindsight](https://github.com/vectorize-io/hindsight). It gives ClawBridge persistent, searchable memory across conversations by storing, indexing, and recalling facts with vector embeddings.

ClawBridge runs Hindsight as Docker services from `integrations/docker-compose.yml`:

- `hindsight-api` — API, retain/recall/reflect, and MCP server
- `hindsight-db` — PostgreSQL/pgvector storage

---

## Host/Container Boundary — CRITICAL

Hindsight runs on the **host side**. Agent containers never receive Hindsight API keys, database passwords, or LLM credentials.

- Host process (`src/index.ts`): reads `HINDSIGHT_URL` and `HINDSIGHT_API_KEY` from `~/.clawbridge/.env`, calls Hindsight, and injects recalled context into agent turns.
- Agent containers: no direct Hindsight environment access. Memory retrieval is injected as context by the host.
- Hindsight container: reads OpenAI Codex OAuth from a read-only mount of `~/.codex/auth.json`.

This keeps memory and channel credentials out of untrusted agent sandboxes.

---

## The Three Operations

### 1. Recall before container wake

```text
host receives message
  → recall(query=message, bank=client-{agentGroupId}--{messagingGroupId}, tags=[scope], all_strict)
  → inject top-k results into the agent context
  → wake container
```

### 2. Retain after each delivered turn

```text
container turn completes
  → host delivers response
  → retain(content=turn_summary, bank=client-{agentGroupId}--{messagingGroupId})
```

### 3. Reflect during host sweep

```text
host sweep
  → reflect(bank) for each active conversation's bank (capped per evening)
```

Reflect consolidates redundant memories, promotes important facts, and prunes stale entries.

---

## LLM Provider and Authentication

Hindsight must use **OpenAI Codex OAuth**, not OpenAI API-key billing.

ClawBridge configures Hindsight with:

```env
HINDSIGHT_LLM_PROVIDER=openai-codex
HINDSIGHT_LLM_MODEL=gpt-5.4-mini
```

The Hindsight Docker service maps this to Hindsight's API env vars:

```yaml
HINDSIGHT_API_LLM_PROVIDER: ${HINDSIGHT_LLM_PROVIDER:-openai-codex}
HINDSIGHT_API_LLM_MODEL: ${HINDSIGHT_LLM_MODEL:-gpt-5.4-mini}
```

The Hindsight image's `openai-codex` provider reads ChatGPT/Codex OAuth from:

```text
/home/hindsight/.codex/auth.json
```

`integrations/docker-compose.yml` provides that file by mounting the host Codex auth directory read-only:

```yaml
volumes:
  - ${HOME}/.codex:/home/hindsight/.codex:ro
```

To authenticate or refresh the token, run on the host:

```bash
codex login --device-auth
```

Do **not** set Hindsight to `openai` with `OPENAI_API_KEY` unless you intentionally want separate OpenAI API billing.

---

## Model Config

Default model for retain, consolidation, and reflect:

```env
HINDSIGHT_LLM_MODEL=gpt-5.4-mini
HINDSIGHT_API_RETAIN_LLM_MODEL=gpt-5.4-mini
HINDSIGHT_API_CONSOLIDATION_LLM_MODEL=gpt-5.4-mini
HINDSIGHT_API_REFLECT_LLM_MODEL=gpt-5.4-mini
```

`clawbridge-codex doctor --fix` normalizes these values when Hindsight is enabled.

---

## Bank Naming and Scoping

Every **conversation** gets its own isolated memory bank, one per agent group and messaging group:

```text
client-{agentGroupId}--{messagingGroupId}   # a channel, group chat, or one person's DM
client-{agentGroupId}--internal             # agent-to-agent and system runs (never DM content)
```

The scope comes from `memoryScopeForSession()` in `src/memory/scope.ts`. Because a DM is its own messaging group, something said in one person's DM can never be recalled in a channel, in another DM, or by another agent group. Reads also require the scope tag with `all_strict`, so untagged memories never match.

Sharing knowledge across conversations is intentionally not automatic. It will need host-stamped visibility and an explicit promotion step; see `docs/product-spec.md` §4.

Banks are created automatically on first use. Memories retained before this change sit in the old shared `client-global` bank and are no longer recalled.

## Version

The server image is pinned in `integrations/docker-compose.yml` (`ghcr.io/vectorize-io/hindsight:1.2.0`) to match `@vectorize-io/hindsight-client` in `package.json`. Bump both together.

---

## Configuration Keys (`~/.clawbridge/.env`)

- `HINDSIGHT_URL`: Base URL of the Hindsight API. Default: `http://localhost:8888`.
- `HINDSIGHT_API_KEY`: Tenant API key for authenticating host requests to Hindsight.
- `HINDSIGHT_DB_PASSWORD`: PostgreSQL password for the Hindsight database container.
- `HINDSIGHT_LLM_PROVIDER`: Should be `openai-codex` for Codex OAuth.
- `HINDSIGHT_LLM_MODEL`: Codex model used by Hindsight LLM operations.

---

## Troubleshooting

**Check if Hindsight is healthy:**

```bash
curl -s http://localhost:8888/health -H "x-api-key: <your-key>" | jq
# Expected: {"status":"healthy","database":"connected"}
```

**Check container logs:**

```bash
docker logs hindsight-api --tail 50
docker logs hindsight-db --tail 20
```

**Hindsight reports missing Codex credentials:**

```bash
codex login --device-auth
cd ~/.clawbridge && docker compose up -d --force-recreate hindsight-api
```

Then confirm the mount exists inside the container:

```bash
docker exec hindsight-api test -f /home/hindsight/.codex/auth.json && echo ok
```

**Hindsight not healthy after `clawbridge-codex upgrade`:**

```bash
cd ~/.clawbridge && docker compose pull hindsight-api && docker compose up -d hindsight-api
```

**Run `clawbridge-codex doctor --fix`** to check Hindsight health and normalize Codex OAuth provider settings.
