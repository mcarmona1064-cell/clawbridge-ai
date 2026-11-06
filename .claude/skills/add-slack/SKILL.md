---
name: add-slack
description: Add the Slack channel integration (native Events API adapter shipped in trunk).
---

# Add Slack Channel

Adds Slack support.

## Install

ClawBridge AI ships a native Slack adapter in trunk (`src/channels/slack.ts`: Events API inbound, Web API outbound, sender identity, approval buttons, threading, retries). **Do not overwrite it** with the older Chat-SDK adapter from the `channels` branch.

### Pre-flight (idempotent)

If `src/channels/slack.ts` exists and contains `SLACK_BOT_SCOPES`, the native adapter is installed: skip steps 1, 2 and 4, make sure step 3's import is present, then go to **Credentials**.

Only for an old checkout without the native adapter, continue with every step below. Each is safe to re-run.

### 1. Fetch the channels branch

```bash
source setup/lib/channels-remote.sh
CHANNELS_REMOTE=$(resolve_channels_remote)
git fetch "$CHANNELS_REMOTE" channels
```

### 2. Copy the adapter

```bash
git show ${CHANNELS_REMOTE}/channels:src/channels/slack.ts > src/channels/slack.ts
```

### 3. Append the self-registration import

Append to `src/channels/index.ts` (skip if the line is already present):

```typescript
import './slack.js';
```

### 4. Install the adapter package (pinned)

```bash
pnpm install @chat-adapter/slack@4.26.0
```

### 5. Build

```bash
pnpm run build
```

## Credentials

### Create Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App** > **From scratch**
2. Name it (e.g., "ClawBridge") and select your workspace
3. Go to **OAuth & Permissions** and add Bot Token Scopes:
   - `chat:write`, `channels:history`, `groups:history`, `im:history`, `channels:read`, `groups:read`, `users:read`, `reactions:write`
4. Click **Install to Workspace** and copy the **Bot User OAuth Token** (`xoxb-...`)
5. Go to **Basic Information** and copy the **Signing Secret**

### Enable DMs

6. Go to **App Home** and enable the **Messages Tab**
7. Check **"Allow users to send Slash commands and messages from the messages tab"**

### Event Subscriptions

8. Go to **Event Subscriptions** and toggle **Enable Events**
9. Set the **Request URL** to `https://your-domain/webhook/slack` — Slack will send a verification challenge; it must pass before you can save
10. Under **Subscribe to bot events**, add:
    - `message.channels`, `message.groups`, `message.im`, `app_mention`
11. Click **Save Changes**
12. Slack will show a banner asking you to **reinstall the app** — click it to apply the new event subscriptions

### Configure environment

Add to `.env`:

```bash
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_SIGNING_SECRET=your-signing-secret
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

### Webhook server

The Chat SDK bridge automatically starts a shared webhook server on port 3000 (configurable via `WEBHOOK_PORT` env var). The server handles `/webhook/slack` for Slack and other webhook-based adapters. This port must be publicly reachable from the internet for Slack to deliver events.

If running locally, discuss options for exposing the server — e.g. ngrok (`ngrok http 3000`), Cloudflare Tunnel, or a reverse proxy on a VPS. The resulting public URL becomes the base for `https://your-domain/webhook/slack`.

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, run `/manage-channels` to wire this channel to an agent group.

## Channel Info

- **type**: `slack`
- **terminology**: Slack has "workspaces" containing "channels." Channels can be public (#general) or private. The bot can also receive direct messages.
- **platform-id-format**: `slack:{channelId}` for channels (e.g., `slack:C0123ABC`), `slack:{dmId}` for DMs (e.g., `slack:D0ARWEBLV63`)
- **how-to-find-id**: Right-click a channel name > "View channel details" — the Channel ID is at the bottom (starts with C). For DMs, the ID starts with D. Or copy the channel link — the ID is the last segment of the URL.
- **supports-threads**: yes
- **typical-use**: Interactive chat — team channels or direct messages
- **default-isolation**: Same agent group for channels where you're the primary user. Separate agent group for channels with different teams or sensitive contexts.
