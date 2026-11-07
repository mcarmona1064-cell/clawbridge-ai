# ClawBridge AI: every channel, easy to use

Goal: a non-technical owner gets a working agent on their first channel in under 15 minutes, adds each further channel in under 5, and never needs a terminal after setup. Slack, WhatsApp, Telegram and Discord are first-class. Teams, Google Chat, Signal, iMessage, Matrix and email follow.

The earlier host-exec and command-registry plan is in `tasks/todo-archive-host-exec.md`.

## Where the channels stand (audit, 2026-11-06)

| | Slack | Telegram | WhatsApp (Cloud API) | Discord |
|---|---|---|---|---|
| Sender id and name | yes | yes | **no** (no senderId or name) | **no** senderId |
| Webhook signature | yes | n/a (long poll) | **no** (X-Hub-Signature-256 unchecked) | n/a (gateway) |
| Dedupe of retries | yes | update_id offset | **no** | n/a |
| Send errors throw | yes | yes | **no** (`messages[0].id` or undefined) | partly |
| Long-text split | yes | **no** (4096 limit) | **no** (4096 limit) | yes |
| Formatting | markdown blocks | **plain text** | plain text | markdown |
| Choices/approvals | buttons | **none** | **none** | **none** |
| Edit / reaction | yes | no | no | no |
| Files out | yes | yes | **no** | **no** |
| Threads | replies in thread | n/a | n/a | **threadId ignored on send** |

So approvals, `ask_user_question`, `/teamfact` and team memory only work on Slack today.

## Milestone 0: one channel layer

- [x] 0.1 **Capability model.** Add `src/channels/capabilities.ts` with `ChannelCapabilities`: threads, choices (buttons max, list max, label max), edit, reactions, typing, filesOut, voiceIn, maxText, format dialect, commands, home, openDM and replyWindowHours. `ChannelAdapter.capabilities?` holds the values, with `capabilitiesFor(channelType)` as the fallback. Features read capabilities, not channel names.
- [x] 0.2 **One renderer.** Add `src/channels/render.ts`: `toTelegramHtml`, `toWhatsApp`, `toDiscord`, `toPlain` and Slack passthrough, plus a shared `splitText(text, limit)` that never splits inside a code fence. Add a `planChoices(caps, options)` helper that returns buttons, list or numbered.
- [x] 0.3 **Choices on every channel.**
  - Telegram: inline keyboard plus `callback_query`, then `answerCallbackQuery` and an edit that removes the buttons.
  - WhatsApp: reply buttons (max 3, 20-character titles) or list (max 10), with inbound `interactive.button_reply` and `list_reply`.
  - Discord: button components plus InteractionCreate, then disable the buttons.
  - Plain channels: a numbered-reply fallback through a `numbered_prompts` table that the router intercepts.
  - All of them reuse `ncq:{questionId}:{idx}` and go through `onAction`, so the existing auth, expiry and records apply.
- [x] 0.4 **Question expiry.** `pending_questions` get the same TTL as approvals, and stale clicks are refused politely.
- [x] 0.5 **Cross-channel identity.**
  - `user_links` (alias user id → primary user id) and `link_codes`.
  - `/link` in a DM issues a 6-digit code (10 minutes, single use).
  - `/link <code>` from the other account in a DM sends a confirm card to the first account. Linking only happens after that approval.
  - Roles, admin checks, approver picking and `/usage` resolve through the primary id.
  - `/unlink`.
- [x] 0.6 **Admin's channel.** `/notify-here` sets the approvals and alerts channel per user, and `pickApprovalDelivery` prefers it across linked accounts.
- [x] 0.7 **Adapter contract suite.** `src/channels/contract/` holds one spec run against a fake platform for Slack, Telegram, WhatsApp and Discord. It covers:
  - sender identity, dedupe and retries, DM vs group, mention handling
  - choices and clicks
  - edit or its fallback, files in and out, voice transcription
  - long-message splitting, errors that throw, rate-limit backoff
- [x] 0.8 **Bring Telegram, WhatsApp and Discord to Slack's quality.**
  - WhatsApp: signature check (`WHATSAPP_APP_SECRET`), senderId and name from `contacts`, dedupe, thrown errors, splitting, files out, read receipts as the ack.
  - Telegram: HTML formatting, splitting, edits, reactions, files out by type.
  - Discord: senderId and name, reply in the thread or reply-to, files out, edits, reactions.
- [x] 0.9 **Docs.** Add `docs/channels.md` with a capability matrix and the graceful fallbacks.

## Milestone 1: safety floor

- [x] 1.1 **No public URL where the platform allows it:**
  - Slack Socket Mode, the default when `SLACK_APP_TOKEN` is set
  - Telegram long polling, already done
  - the Discord gateway, already done
  - for WhatsApp, a guided `cloudflared` tunnel helper plus the signature check
- [x] 1.2 **Egress proxy.** A host egress proxy with placeholder secrets. Containers get `CLAWBRIDGE_PLACEHOLDER_*` and the proxy swaps in real headers for allowlisted hosts only. The Codex `auth.json` is mounted read-only. Containers reach only the proxy.
- [x] 1.3 **Slack agent_view.** `assistant.threads.setStatus` and `agents.sessions.setStatus` statuses, with `agent_session_stopped` mapped to stop.
- [x] 1.4 **Audit table.** An append-only `audit_log` (triggers block UPDATE and DELETE) covering approvals, host_exec, provider switches, role changes, identity links, memory writes and outbound posts. `clawbridge-ai audit export --format jsonl|csv`.
- [x] 1.5 **WhatsApp policy.**
  - A 24-hour window tracker. Outside the window, a send must use a template; otherwise it fails with a clear message.
  - `WHATSAPP_TEMPLATES` config, plus a setup helper.
  - STOP/START opt-out handling.

## Milestone 2: easy to use

- [x] 2.1 **Install and setup.** A one-command install (`npx clawbridge-ai`) and a wizard per channel (Slack manifest link, Telegram BotFather, WhatsApp Meta steps, Discord invite link) that ends in a real reply on each.
- [~] 2.2 **Doctor.** Plain-English failures, each with the exact fix, for every channel.
- [x] 2.3 **Add a channel from chat.** "Connect our WhatsApp" gets a guided walkthrough on the current channel.
- [x] 2.4 **Onboarding.** An onboarding conversation that saves its answers as team memory and offers 3 starter tasks as choices.
- [~] 2.5 **Configure by chat.** Configure from chat: which chats it answers in, schedules, permissions and provider.
- [x] 2.6 **Home screens.**
  - Slack App Home
  - Telegram commands menu
  - Discord slash commands
  - a `/status` card everywhere
  - a localhost admin console
- [~] 2.7 **Commands and errors.** The same commands everywhere (/help, /status, /usage, /memory, /permissions, /tasks, /provider, plus !stop, !mute, !fast and !deep), and friendly errors with an admin alert.
- [~] 2.8 **Native behaviour.**
  - An instant ack and progress updates.
  - Rework choices.
  - Telegram forum topics.
  - WhatsApp voice replies (opt-in).
  - In groups, reply only when addressed.
  - Log every reply/no-reply decision.

## Milestone 3: trust and cost

- [x] 3.1 **Usage ledger.** Usage ledger plus budgets, alerts and pause-and-queue.
- [x] 3.2 **Policies.** Allow/ask/deny policies with risk labels, scoped "always allow" and `/permissions`.
- [x] 3.3 **Claim-receipt gate.** Claim-receipt gate and idempotency keys.
- [x] 3.4 **Egress guard.** Audience-aware egress guard across channels.
- [x] 3.5 **RBAC.** RBAC (Owner, Admin, Approver, User, Auditor) on linked identities, plus policies for unknown senders.

## Milestone 4: capabilities

- [x] 4.1 **Integration SDK.** Integration SDK with host-held credentials and approval before sending.
- [x] 4.2 **Cheap crons.** Gated crons that are cheap to run.
- [x] 4.3 **Deliverables.** Deliverables sent as native files on each channel, plus signed hosted pages.
- [x] 4.4 **Media and voice.** Media in and voice out everywhere.
- [x] 4.5 **Takeover browser.**
- [x] 4.6 **DuckDB data.** Read-only DuckDB data access.
- [x] 4.7 **Skills library.** Pinned skills library.
- [x] 4.8 **Proactivity.** Opt-in proactivity.
- [x] 4.9 **Model routing.** Model routing presets.
- [x] 4.10 **Remaining channels.** Bring the remaining channels onto the contract suite.

## Quality bar

- **Eval suite.** 30–50 two-sided tasks, run on both providers and every first-class channel, pass^3, with reply/no-reply grading and a cross-channel leak canary. Runs in nightly CI.
- **Proof before done.** Every item ships with tests, and gets live-check steps per channel at the end of its milestone.

## Review

### Milestone 0 (pushed to `ai` main at 028c9aa, 2026-11-06)

**What changed for users, by channel**

- **Slack:** card bodies now render Markdown. Everything else was already in place.
- **Telegram:**
  - Approval and question cards are tappable buttons, and the card shows who chose what.
  - Replies are formatted as Telegram HTML and split at 4,096 characters.
  - New: edits, reactions, and files sent as photo, video, voice or document.
- **WhatsApp:**
  - Webhooks are signature-checked (`WHATSAPP_APP_SECRET`) and retries are dropped.
  - Every message carries the sender's id and name, so approvals, roles and `/teamfact` now work on WhatsApp.
  - Cards are reply buttons or lists, with WhatsApp formatting.
  - Files, reactions, read receipts and typing work.
  - Failures throw, so delivery retries them.
- **Discord:**
  - Sender id and name.
  - A mention starts a thread, and follow-ups there need no mention.
  - Cards are buttons; edits, reactions, files and typing work; DMs can be opened for approvals.
- **Plain-text channels:** cards become numbered lists and a reply of "2" answers them.
- **Every channel:**
  - `/link` joins one person's accounts after the original account confirms.
  - `/notify-here` picks where approvals arrive.
  - Question cards expire like approvals.

**Verified:**
- 367 host tests pass, including the 50-check adapter contract suite, the identity tests and the channel-layer tests.
- The agent-runner tests show 28 passing and the 6 known failures.

**Not verified:**
- Nothing has been tested against live Slack, WhatsApp, Telegram or Discord accounts.
- Discord was tested against a fake client, not discord.js's real gateway.

**Live checks, per channel**

1. **Telegram.** DM the bot `/link`. Then send any message that triggers an approval (for example, ask the agent to save a team fact). Tap Approve, and the card should update with your name.
2. **WhatsApp.**
   - Set `WHATSAPP_APP_SECRET` and run `clawbridge-ai doctor`; it should pass.
   - Send a voice note. It should be transcribed.
   - Trigger an approval: you should get two reply buttons.
3. **Discord.** @mention the bot in a channel. It should reply in a new thread. Then post a follow-up in that thread without a mention, and the bot should answer.
4. **Cross-channel linking.**
   - `/link` on Slack, then `/link <code>` on WhatsApp.
   - Approve on Slack.
   - `/accounts` on WhatsApp should list both accounts.
   - `/notify-here` on WhatsApp, then trigger an approval from Slack: the card should arrive on WhatsApp.

**Follow-ups found along the way:**
- The WhatsApp setup step still installs the unofficial Baileys library. Switching setup to Cloud API by default belongs to M2 item 2.1.

### Milestone 1 (pushed to `ai` main, 2026-11-06)

**What changed for users, by channel**

- **Slack:**
  - With `SLACK_APP_TOKEN`, Socket Mode works with no public URL; the manifest turns it on.
  - While the agent works, Slack's agent-session status line and stop button appear. The status reads "suspended" while a card waits on someone, and stop ends the turn.
- **WhatsApp:**
  - `clawbridge-ai tunnel` prints a public callback URL to paste into Meta.
  - The 24-hour reply window is enforced; later messages use `WHATSAPP_TEMPLATE_NAME` or are refused clearly.
  - STOP/START opt-outs work.
- **Telegram and Discord:** already needed no public URL. Nothing new here.
- **Every channel:**
  - An append-only, hash-chained audit log, with `clawbridge-ai audit export|verify`.
  - Admin alerts now go only to owners and admins. They used to go to every chat the bot was in, a privacy bug fixed this milestone.
  - With `CREDENTIAL_PROXY=on`, Claude containers hold a per-session placeholder instead of the real token.
  - `EGRESS_PROXY=on` blocks private, LAN and cloud-metadata addresses, and enforces `EGRESS_ALLOWLIST`.

**Verified:**
- 395 host tests pass.
- The real Claude Code CLI sends the placeholder to the proxy correctly: `Bearer cbp_…`, plus the `/api/hello` probe.

**Not verified:**
- The live proxy round trip to Anthropic.
- Socket Mode against a real Slack app.
- `agents.sessions.setStatus` in a real workspace.
- WhatsApp templates with Meta.

**Still open in M1 scope:**
- Network-level lockdown: an internal Docker network whose only route out is the proxy. Needs Docker to build and test.
- Proxying the Codex `auth.json`, which Codex rewrites itself.

**Live checks**
1. **Slack:**
   - Create the app from the manifest, add an app-level token, set `SLACK_APP_TOKEN`, and restart. The logs should say "Using Socket Mode".
   - DM the bot. The status line should show while it works, and Stop should end the turn.
2. **WhatsApp:**
   - Run `clawbridge-ai tunnel` and paste the URL into Meta.
   - Send "hi" and get a reply.
   - Send STOP: you get a confirmation, and the agent stops replying until START.
3. **Proxy:**
   - Set `CREDENTIAL_PROXY=on` and restart, then send a message.
   - `docker exec <container> env | grep CLAUDE` should show only `cbp_…`.
4. **Audit:** `clawbridge-ai audit verify` should report the hash chain intact.

**Incident during verification:**
- While checking the proxy with the host's `claude` CLI, Claude Code fell back to the Mac's keychain subscription login for the API-key test. It sent those real tokens to a local test server on 127.0.0.1.
- Nothing left the machine, and the log was deleted. The tokens did appear in the session transcript, so the user was asked to sign out of the CLI and back in.
- Lesson: when testing credential handling with a real CLI, run it with an empty HOME so it can't fall back to stored logins.

### Milestone 2 (pushed to `ai` main, 2026-11-06)

**What changed for users, by channel**

- **Setup:**
  - `clawbridge-ai` now walks through each channel and checks every credential with the platform before saving it.
  - **Slack:** a one-click app link with Socket Mode turned on.
  - **WhatsApp:** the Cloud API steps, the app secret, and a generated verify token.
  - **Discord:** an invite link with exactly the permissions the bot needs.
  - **Telegram:** BotFather steps.
  - The finish screen says how to get the first reply on each channel.
- **From chat:**
  - `/connect slack|whatsapp|telegram|discord` adds a channel without a terminal. Tokens are caught before they reach the agent or its memory.
  - The first DM from an owner offers a four-question setup. Answers go to team memory and a team profile, then three starter tasks follow as buttons.
  - `/onboard` re-runs that setup.
- **Every channel:**
  - `!stop`, `!mute [hours]` and `!unmute`.
  - `/help` in plain words; it used to be silently dropped.
  - `/status` shows a status card.
  - `/tasks` lists jobs; admins can cancel them.
  - `/reply mentions|all`, plus `/why` for recent answer/quiet decisions.
  - Friendly error messages, with the details sent to the admin.
- **Slack:** a Home tab with agents, approvals, jobs and linked accounts. A 👀 reaction appears as soon as the agent picks a message up.
- **Telegram:**
  - Forum topics are separate conversations that inherit the group's setup.
  - Replying to the bot counts as a mention.
  - 👀 acknowledgement.
- **Discord:** the slash command menu (`/help`, `/status`, `/tasks`, `/stop`, `/mute`, …) and 👀 acknowledgement.
- **WhatsApp:** the read receipt and typing indicator act as the acknowledgement.
- **Host:** a token-protected local admin console (`clawbridge-ai console`). Doctor checks Slack Socket Mode.

**Verified:**
- 433 host tests pass.
- The agent-runner tests show the 6 known failures and no new ones.

**Not verified live:** every platform flow above. Fakes, not real accounts, back each test.

**Still open in M2 scope:**
- An `npx clawbridge-ai` one-liner: the package isn't published to npm.
- `/usage`, `/memory`, `/permissions`: they need the M3 usage ledger and policy model.
- `!fast` and `!deep`: they need M4 model routing.
- Rework buttons (Shorter, Fix this part, Undo).
- WhatsApp voice replies: they need a text-to-speech provider.
- The legacy `setup:auto` flow still uses Baileys for WhatsApp.

**Live checks**
1. **Setup:** run `clawbridge-ai` with Slack selected. The app link should open Slack with the manifest prefilled; paste both tokens; doctor should show "Slack Socket Mode" passing.
2. **Chat commands:**
   - In a Telegram DM, send `/connect discord` and follow the steps; the bot should come online without a restart.
   - Send `!mute 1`, then a message: no reply. `!unmute`.
3. **Onboarding:** DM the agent as the owner, tap "Start setup" and answer the questions. A new conversation should know the business.
4. **Console:** `clawbridge-ai console` → open the link; you should see the channels and the audit log.

### Milestone 3 (pushed to `ai` main, 2026-11-06)

**What changed for users (the same on every channel)**

- **Usage and budgets:**
  - `/usage` shows this month's replies, tokens and API-price estimate. The per-person breakdown is visible to admins and auditors only.
  - `/budget 5M|$50|off` sets a monthly budget per agent, with alerts at 50, 75, 90 and 100%.
  - At the cap, messages are held and the chat is told.
- **Permissions:**
  - Approval cards show a risk badge and, where safe, an "Always allow `npm test`" button.
  - `/permissions` lists, revokes and denies rules.
  - Deleting, sudo, downloads, `git push`, chained shell commands and secrets always ask.
- **Honesty:**
  - A reply that claims it scheduled something, saved to team memory or posted elsewhere, with no matching action recorded, gets a correction.
  - Anything written in a DM needs approval before it goes to a group.
- **Roles:** approver and auditor roles, managed with `/roles`.
- **Memory:** `/memory` shows, searches and forgets memories, and checks each deletion.

**Verified:** 458 host tests and the runner usage tests pass.

**Not verified live:**
- That real Claude and Codex runs report usage in the shapes parsed here. The parsers follow the SDK and CLI event formats.
- That Hindsight 1.2.0's delete-document call behaves like the test fake.

**Gaps:**
- No cost footer on replies: usage arrives after the reply is sent.
- No idempotency keys beyond the existing per-message ids.
- No evidence links in replies.

**Live checks**
1. **Usage:** send a few messages, then `/usage`. Then `/budget 1k`, send one more, and check that the chat says messages are held. `/budget off` releases them.
2. **Always allow:** with `allowHostExec`, ask the agent to run `npm test`. Tap "Always allow `npm test`", ask again, and it should run without a card. `/permissions` lists the rule.
3. **Audience guard:** DM the agent "post 'hello' in #general". An approval card should appear first.
4. **Memory:** `/memory`, then `/memory forget <id>`, then `/memory` again: the item should be gone.

### Milestone 4 (pushed to `ai` main, 2026-11-07)

**What changed for users (every channel unless noted)**

- **Apps.**
  - GitHub, Linear, Jira, Notion, HubSpot, Stripe, Shopify, Gmail, Calendar, Drive, Sheets and custom REST APIs, through `integration_request`. Credentials stay on the host.
  - Reads run directly. Writes go to an approval card, are idempotent, and come back with an evidence link. Stripe and Shopify always ask.
- **Thinking level.** `!fast`, `!deep`, `!normal` and `/model`: Haiku/Sonnet/Opus 5.5 on Claude, effort levels on Codex.
- **Scheduling and digests.**
  - Frequent jobs need a condition script, and jobs can't create recurring jobs.
  - `/digest on 9:00`; quiet days post nothing.
- **Deliverables and data.**
  - `share_file` makes signed, expiring links for reports and pages.
  - `query_data` runs read-only DuckDB over workspace files.
- **Browser.** `browser_handoff` sends a private live link to take over for sign-ins. What the person types never reaches the agent.
- **Skills.**
  - `/skills install owner/repo@<sha>`, with a safety scan and an approval card.
  - `/skills update` shows the diff.
  - `propose_skill` records a procedure as a skill (record-to-skill).
- **Voice and costs.**
  - `/voice on` answers voice notes with voice, using a TTS key on the host.
  - `/usage footer on` adds a cost footer.
- **Rework.** `!shorter`, `!longer`, `!simpler`, `!redo`, `!undo`.
- **Security.**
  - `EGRESS_LOCKDOWN=on`: an internal Docker network whose only exit is a relay to the host proxy.
  - `CODEX_AUTH_READONLY=on`.
  - Slack guests and Slack Connect users are refused by default.
- **Channels.** Teams, Google Chat and Webex keep buttons. The Chat SDK bridge runs the outbound contract suite.
- **Setup.**
  - `setup:auto` defaults WhatsApp to the Cloud API.
  - `npx github:mcarmona1064-cell/clawbridge-ai` builds itself.
  - Doctor checks Node 22 for Socket Mode.
- **Evals.** 44 two-sided cases on Claude and Codex, pass^3 (88/88). They run on every PR and nightly (`.github/workflows/nightly.yml`), with the report kept as an artifact.

**Verified:**
- 507 host tests.
- 88/88 eval runs.
- Agent-runner tests: 43 pass, plus the 6 known failures and no new ones.
- The real Claude Code CLI sends the proxy placeholder correctly.

**Not verified live (no Docker on this machine, and no live accounts):**
- The image build with DuckDB.
- `query_data` running against real DuckDB.
- The browser hand-off with real agent-browser.
- The lockdown network and relay.
- Live integration calls.
- Real TTS.
- Every platform flow.

**Live checks**
1. **Image:** `clawbridge-ai build-image`. Then, in a container, `duckdb --version`.
2. **Apps:** put `GITHUB_TOKEN` in `.env` and ask "list open issues in acme/web". It should answer without a card. Then "open an issue titled Test": you should get an approval card, and the result should include a link.
3. **Browser:** ask the agent to sign in somewhere. A hand-off link should arrive. Type the password on that page and press Done; the agent carries on.
4. **Lockdown:** set `EGRESS_LOCKDOWN=on` and restart. `docker network inspect clawbridge-egress` should list the relay. From inside a container, `curl https://example.com` without the proxy should fail.
5. **Skills:** `/skills install <owner/repo>@<sha>` → review the card → approve. Then `/skills`.
6. **Evals:** `pnpm run eval` should give a pass^3 of 88/88 in `evals/report.json`.

