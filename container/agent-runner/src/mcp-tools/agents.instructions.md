## Companion and collaborator agents (`create_agent`)

`mcp__clawbridge__create_agent({ name, instructions })` spins up a new long-lived agent and wires it as a destination — bidirectional, so you can send it tasks and it can message you back.

### How it works

- Creates a new agent with its own container, workspace, and session. Your `instructions` string seeds the agent's `AGENTS.local.md` — its starting role and personality.
- The agent's `name` becomes a destination on both sides: you address it via `send_message({ to: "<name>", ... })`, and its replies arrive as inbound messages with `from="<name>"`.
- Each agent has its own persistent workspace under `groups/<folder>/` — memory, conversation history, and notes all survive across sessions. This is a full standalone agent, not a stateless sub-query.
- **Fire-and-forget:** the call returns immediately without waiting for the agent to confirm it's ready. Messages you send will queue until it's up.

### When to use

- **Companions** — a long-running presence that accumulates context over time: a `Researcher` tracking an ongoing inquiry, a `Calendar` agent managing scheduling, an assistant that knows your preferences and history.
- **Collaborators** — a parallel specialist that works independently and reports back: a `Builder` handling code edits while you stay in conversation, a `Reviewer` running checks in the background.

The right frame is: does this agent need its own memory and context that builds over time, or does it need to work independently without blocking your turn? Either is a good reason to spawn one.

### When NOT to use

- **One-off lookups or short tasks** — use the SDK `Agent` tool instead. It's stateless, spins up and completes in one shot, and leaves no persistent footprint.
- **Work that finishes before the user's next message** — agents persist indefinitely. Don't create one for something you could do inline.

### Writing good `instructions`

Cover: the agent's role, who it takes tasks from (you, by name), how it should report back (on completion only? with milestones for long work?), and any domain-specific rules. Don't restate ClawBridge base behavior — the shared base is already loaded on the agent's end.

### One-time task agents (`run_task`)

`run_task({ prompt, role?, timeout_minutes? })` spawns a temporary one-shot agent, sends it the task, and delivers the result back to you when it's done. The agent container is **automatically torn down** after it replies — no persistent footprint.

- **prompt** — the task to execute (required)
- **role** — optional specialization (e.g. "You are a web researcher specializing in financial data")
- **timeout_minutes** — how long to wait before abandoning (default: 10, max: 60)

#### When to use `run_task` vs `create_agent`

| `run_task` | `create_agent` |
|---|---|
| One focused task, one reply | Long-lived companion with memory |
| Auto-cleaned up after reply | Persists indefinitely |
| No persistent workspace | Own workspace across sessions |
| Ideal for parallel research, drafts, analysis | Ideal for specialists you address repeatedly |

#### Parallel execution with `run_task`

Call `run_task` multiple times in a row (fire-and-forget) to dispatch parallel workstreams. Each spawns an independent container. Replies arrive as normal inbound messages from the task agent.

Example: dispatching three parallel research tasks
```
run_task({ prompt: "Summarise recent news on X", role: "news analyst" })
run_task({ prompt: "Analyse competitor pricing for Y", role: "market analyst" })
run_task({ prompt: "Draft a 3-bullet exec summary for Z" })
```
All three run simultaneously. You receive each result as it completes.

