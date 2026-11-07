# Channels

ClawBridge AI runs the same agent on every channel. Each channel adapter declares what its platform can do (`src/channels/capabilities.ts`). Features read those capabilities instead of the channel's name, and where a platform lacks something there is a defined fallback, never a silent gap.

**First-class channels:** Slack, WhatsApp (Meta Cloud API), Telegram and Discord. Each one passes the same adapter contract suite (`src/channels/contract.test.ts`).

**Other channels:**
- Teams, Google Chat, Webex and Matrix are installed by skills and run through the Chat SDK bridge. The bridge passes the outbound part of the suite (cards with the shared choice ids, splitting, edits, reactions, files, errors that throw), and each of these channels declares its capabilities: Teams, Google Chat and Webex get buttons.
- Signal, iMessage and email are plain-text channels, so their cards fall back to numbered replies.
- Live inbound checks for these channels are still to come.

## What each channel supports

| | Slack | WhatsApp | Telegram | Discord | Plain-text channels |
|---|---|---|---|---|---|
| Who sent it (`senderId` + name) | ✅ | ✅ (profile name) | ✅ | ✅ (display name) | adapter-dependent |
| Groups | ✅ channels | — 1:1 only on the Cloud API | ✅ | ✅ servers | adapter-dependent |
| Threads | ✅ replies in thread | — | — | ✅ starts a thread on mention | — |
| Question / approval cards | buttons (25) | reply buttons (3) or list (10) | inline keyboard | buttons (25) | numbered reply |
| Formatting | Markdown blocks | WhatsApp `*bold* _italic_ ~strike~` | Telegram HTML | Markdown | plain text |
| Longest message | 11,000 | 4,096 | 4,096 | 2,000 | 4,000 |
| Edit a sent message | ✅ | — sends a new message | ✅ | ✅ | — sends a new message |
| Reactions | ✅ | ✅ | ✅ (Telegram's emoji set) | ✅ | — dropped |
| Typing indicator | ✅ | ✅ (with read receipt) | ✅ | ✅ | — |
| Files out | ✅ | ✅ image/video/audio/document | ✅ photo/video/voice/audio/document | ✅ (10 per message) | adapter-dependent |
| Voice notes in | ✅ transcribed | ✅ transcribed | ✅ transcribed | ✅ transcribed | adapter-dependent |
| Native commands menu | ✅ | — | ✅ (`setMyCommands`) | (planned) | — |
| Needs a public URL | **no** with Socket Mode (`SLACK_APP_TOKEN`), yes for webhooks | yes (Meta webhook) | **no** (long polling) | **no** (gateway) | adapter-dependent |
| Reply window | none | **24 h** after the user's last message, templates outside it | none | none | none |

## Fallbacks

- **Cards with more options than a channel can show** (or channels with no buttons at all) are sent as a numbered list. A reply like `2`, `#2` or the option's label answers the card. It goes through the same response path as a button click, so admin checks, expiry and records all apply. Other messages in the chat still reach the agent normally.
- **Edits** on channels that can't edit arrive as a new message with the updated text.
- **Reactions** on channels without reactions are skipped, since they are only acknowledgements.
- **Long replies** are split at paragraph, line or word breaks. A split inside a code block closes the block and reopens it in the next message.
- **Telegram markup that Telegram rejects** is resent as plain text instead of failing.
- **Long WhatsApp button labels** are cut to fit WhatsApp's 20-character limit, and the full options are written out in the message body.

## Who is who across channels

A person can link their accounts so they are one user everywhere:

1. In a DM with the agent on one channel, send `/link`. You get a 6-digit code, valid for 10 minutes.
2. From your other account, DM the agent `/link <code>`.
3. A confirmation card appears on the first account. The accounts link only after you approve there.

Linked accounts share roles (owner, admin), approvals, per-person memory and usage. Each conversation's memory stays with that conversation. Other commands:

- `/accounts` lists your linked accounts.
- `/unlink` removes this account's link.
- `/unlink <account>` from the primary account removes one alias.
- `/notify-here` (in a DM) makes that chat the place your approval cards and alerts arrive, whichever channel the request came from.

Linking commands work before access checks, so a new account can link itself. Codes and confirmations only work in DMs.

## Channel notes

- **Slack.**
  - Create the app from `setup/channels/slack-app-manifest.json`. It turns on Socket Mode and lists exactly the scopes the adapter uses.
  - Under Basic Information → App-Level Tokens, create a token with `connections:write` and set it as `SLACK_APP_TOKEN`. Socket Mode needs no public URL and no signing secret.
  - Webhook mode (`SLACK_SIGNING_SECRET` with Event and Interactivity URLs pointing at `/webhook/slack`) still works.
  - **Agent sessions** (Slack's agent view):
    - While the agent works, Slack shows its status line and a stop button. The adapter sets `processing`, refreshed every 10 minutes because Slack drops it after an hour. It sets `suspended` while a question or approval card waits on the person, and `active` once it has replied.
    - Pressing stop ends the running turn.
    - The manifest subscribes to `agent_session_stopped`, which Slack requires before it shows a working stop button.
    - In workspaces without agent sessions, the status line turns itself off.
- **WhatsApp rules.**
  - Within 24 hours of the person's last message, the agent can reply freely. After that, WhatsApp only accepts pre-approved templates.
  - Set `WHATSAPP_TEMPLATE_NAME` (and `WHATSAPP_TEMPLATE_LANG`) to a **utility** template with one body variable, for example "Update from your assistant: {{1}}". Late messages, scheduled results and digests are then sent through it.
  - Without a template, a late send is refused with a clear error rather than failing at Meta.
  - When someone sends **STOP** (or unsubscribe, cancel, quit), nothing more is sent to them until they send **START**. Their messages don't reach the agent in the meantime. Opt-outs and blocked sends are recorded in the audit log.
- **WhatsApp.** Meta needs a public HTTPS callback URL. `clawbridge-ai tunnel` opens a Cloudflare quick tunnel and prints the exact URL to paste. Quick-tunnel URLs change on restart, so for a permanent URL point a named tunnel or reverse proxy at the webhook port (3000).
- **WhatsApp API.** Uses the official Cloud API. Set `WHATSAPP_APP_SECRET` so forged webhooks are rejected; doctor flags it when it's missing. Webhooks are acknowledged at once and retries are dropped by message id. The unofficial WhatsApp Web route (Baileys) carries a real risk of the number being banned, and is not the default.
- **Telegram.** No public URL needed. In a forum group, each topic is its own conversation. A new topic inherits the group's agents, and replies go back into that topic. Replying to one of the bot's messages counts as mentioning it.
- **Telegram setup.** In groups, the bot sees every message only if group privacy mode is off (BotFather → `/setprivacy`). Otherwise it sees mentions and commands only.
- **Discord.** No public URL needed. Turn on Message Content Intent. A mention in a server channel starts a thread under that message. Follow-ups in that thread reach the agent without another mention.

## Adding a channel

An adapter implements `ChannelAdapter` (`src/channels/adapter.ts`):

- Declare `capabilities` when the platform differs from the defaults.
- Stamp `senderId: <channel>:<user>` and a display name on inbound messages.
- Throw when a send fails.
- Route card clicks to `onAction(questionId, value, rawUserId)` using the shared `ncq:{questionId}:{idx}` ids from `src/channels/render.ts`.

Then add a harness to `src/channels/contract.test.ts`. The channel is first-class once it passes the suite.
