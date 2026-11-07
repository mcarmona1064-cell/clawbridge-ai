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

- [ ] 1.1 **No public URL where the platform allows it:**
  - Slack Socket Mode, the default when `SLACK_APP_TOKEN` is set
  - Telegram long polling, already done
  - the Discord gateway, already done
  - for WhatsApp, a guided `cloudflared` tunnel helper plus the signature check
- [ ] 1.2 **Egress proxy.** A host egress proxy with placeholder secrets. Containers get `CLAWBRIDGE_PLACEHOLDER_*` and the proxy swaps in real headers for allowlisted hosts only. The Codex `auth.json` is mounted read-only. Containers reach only the proxy.
- [ ] 1.3 **Slack agent_view.** `assistant.threads.setStatus` and `agents.sessions.setStatus` statuses, with `agent_session_stopped` mapped to stop.
- [ ] 1.4 **Audit table.** An append-only `audit_log` (triggers block UPDATE and DELETE) covering approvals, host_exec, provider switches, role changes, identity links, memory writes and outbound posts. `clawbridge-ai audit export --format jsonl|csv`.
- [ ] 1.5 **WhatsApp policy.**
  - A 24-hour window tracker. Outside the window, a send must use a template; otherwise it fails with a clear message.
  - `WHATSAPP_TEMPLATES` config, plus a setup helper.
  - STOP/START opt-out handling.

## Milestone 2: easy to use

- [ ] 2.1 **Install and setup.** A one-command install (`npx clawbridge-ai`) and a wizard per channel (Slack manifest link, Telegram BotFather, WhatsApp Meta steps, Discord invite link) that ends in a real reply on each.
- [ ] 2.2 **Doctor.** Plain-English failures, each with the exact fix, for every channel.
- [ ] 2.3 **Add a channel from chat.** "Connect our WhatsApp" gets a guided walkthrough on the current channel.
- [ ] 2.4 **Onboarding.** An onboarding conversation that saves its answers as team memory and offers 3 starter tasks as choices.
- [ ] 2.5 **Configure by chat.** Configure from chat: which chats it answers in, schedules, permissions and provider.
- [ ] 2.6 **Home screens.**
  - Slack App Home
  - Telegram commands menu
  - Discord slash commands
  - a `/status` card everywhere
  - a localhost admin console
- [ ] 2.7 **Commands and errors.** The same commands everywhere (/help, /status, /usage, /memory, /permissions, /tasks, /provider, plus !stop, !mute, !fast and !deep), and friendly errors with an admin alert.
- [ ] 2.8 **Native behaviour.**
  - An instant ack and progress updates.
  - Rework choices.
  - Telegram forum topics.
  - WhatsApp voice replies (opt-in).
  - In groups, reply only when addressed.
  - Log every reply/no-reply decision.

## Milestone 3: trust and cost

- [ ] 3.1 **Usage ledger.** Usage ledger plus budgets, alerts and pause-and-queue.
- [ ] 3.2 **Policies.** Allow/ask/deny policies with risk labels, scoped "always allow" and `/permissions`.
- [ ] 3.3 **Claim-receipt gate.** Claim-receipt gate and idempotency keys.
- [ ] 3.4 **Egress guard.** Audience-aware egress guard across channels.
- [ ] 3.5 **RBAC.** RBAC (Owner, Admin, Approver, User, Auditor) on linked identities, plus policies for unknown senders.

## Milestone 4: capabilities

- [ ] 4.1 **Integration SDK.** Integration SDK with host-held credentials and approval before sending.
- [ ] 4.2 **Cheap crons.** Gated crons that are cheap to run.
- [ ] 4.3 **Deliverables.** Deliverables sent as native files on each channel, plus signed hosted pages.
- [ ] 4.4 **Media and voice.** Media in and voice out everywhere.
- [ ] 4.5 **Takeover browser.**
- [ ] 4.6 **DuckDB data.** Read-only DuckDB data access.
- [ ] 4.7 **Skills library.** Pinned skills library.
- [ ] 4.8 **Proactivity.** Opt-in proactivity.
- [ ] 4.9 **Model routing.** Model routing presets.
- [ ] 4.10 **Remaining channels.** Bring the remaining channels onto the contract suite.

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
