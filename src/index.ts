/**
 * ClawBridge — main entry point.
 *
 * Thin orchestrator: init DB, run migrations, start channel adapters,
 * start delivery polls, start sweep, handle shutdown.
 */
import path from 'path';

import { DATA_DIR } from './config.js';
import { migrateGroupsToAgentsLocal } from './agents-md-compose.js';
import { initDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { ensureContainerRuntimeRunning, cleanupOrphans } from './container-runtime.js';
import { verifyAndRebuildMissingImages } from './container-runner.js';
import { startActiveDeliveryPoll, startSweepDeliveryPoll, setDeliveryAdapter, stopDeliveryPolls } from './delivery.js';
import { startHostExecWatcher, stopHostExecWatcher } from './modules/host-exec/index.js';
import { startHostSweep, stopHostSweep } from './host-sweep.js';
import { initErrorHandler } from './error-handler.js';
import { startHealthCheck, stopHealthCheck } from './health-check.js';
import { routeInbound } from './router.js';
import { interceptNumberedReply, prepareOutbound } from './channels/channel-layer.js';
import { handleIdentityCommand, isIdentityCommand } from './modules/identity/index.js';
import { stopChatSession } from './stop-session.js';
import { handleChatControl, isChatControl, mutedUntil } from './chat-controls.js';
import { handleConnect, isConnectMessage } from './modules/connect/index.js';
import { log } from './log.js';
import { initMemoryDb, MemoryManager } from './memory/index.js';

// Response + shutdown registries live in response-registry.ts to break the
// circular import cycle: src/index.ts imports src/modules/index.js for side
// effects, and the modules call registerResponseHandler/onShutdown at top
// level — which would hit a TDZ error if the arrays lived here. Re-exported
// here so existing callers see the same surface.
import {
  registerResponseHandler,
  getResponseHandlers,
  onShutdown,
  getShutdownCallbacks,
  type ResponsePayload,
  type ResponseHandler,
} from './response-registry.js';
export { registerResponseHandler, onShutdown };
export type { ResponsePayload, ResponseHandler };

async function dispatchResponse(payload: ResponsePayload): Promise<void> {
  for (const handler of getResponseHandlers()) {
    try {
      const claimed = await handler(payload);
      if (claimed) return;
    } catch (err) {
      log.error('Response handler threw', { questionId: payload.questionId, err });
    }
  }
  log.warn('Unclaimed response', { questionId: payload.questionId, value: payload.value });
}

// Channel barrel — each enabled channel self-registers on import.
// Channel skills uncomment lines in channels/index.ts to enable them.
import './channels/index.js';

// Modules barrel — default modules (typing, mount-security) ship here; skills
// append registry-based modules. Imported for side effects (registrations).
import './modules/index.js';

import type { ChannelAdapter, ChannelSetup } from './channels/adapter.js';
import { initChannelAdapters, teardownChannelAdapters, getChannelAdapter } from './channels/channel-registry.js';

import kleur from 'kleur';

function printBanner(): void {
  const o = kleur.yellow;
  const w = (s: string) => kleur.white().bold(s);
  console.log('');
  console.log(o('  /  /  /   ●'));
  console.log(o(' /  /  /  ●'));
  console.log(o('/  /  /  ●'));
  console.log('');
  console.log(w('C L A W B R I D G E'));
  console.log(w('  AI Agent Platform'));
  console.log('');
}

async function main(): Promise<void> {
  printBanner();
  initErrorHandler();
  initMemoryDb();
  log.info('ClawBridge starting');

  // 1. Init central DB
  const dbPath = path.join(DATA_DIR, 'v2.db');
  const db = initDb(dbPath);
  runMigrations(db);
  log.info('Central DB ready', { path: dbPath });

  // Memory system — load persisted context for this session
  const memoryManager = new MemoryManager('global');
  const memoryContext = await memoryManager.loadForSession();
  if (memoryContext) {
    log.info('[memory] Session context loaded', { chars: memoryContext.length });
  }

  // 1b. One-time filesystem cutover — idempotent, no-op after first run.
  migrateGroupsToAgentsLocal();

  // 2. Container runtime
  ensureContainerRuntimeRunning();
  cleanupOrphans();
  void verifyAndRebuildMissingImages();

  // Self-heal: ensure loginctl linger is active on Linux so the service
  // survives SSH logout. No-op on macOS and when running as root.
  if (process.platform === 'linux' && process.getuid?.() !== 0) {
    try {
      (await import('child_process')).execSync('loginctl enable-linger', { stdio: 'pipe' });
    } catch {}
  }

  // 3. Channel adapters
  await initChannelAdapters((adapter: ChannelAdapter): ChannelSetup => {
    return {
      onInbound(platformId, threadId, message) {
        const inboundContent = (message.content ?? {}) as {
          text?: unknown;
          senderId?: unknown;
          sender?: unknown;
          author?: unknown;
        };

        // /connect <channel>: guided channel setup from chat. Tokens typed during
        // the flow are handled here and never reach the agent or its memory.
        if (
          typeof inboundContent.text === 'string' &&
          isConnectMessage({
            channelType: adapter.channelType,
            platformId,
            text: inboundContent.text,
            senderId: senderIdOf(adapter.channelType, inboundContent),
          })
        ) {
          void handleConnect({
            channelType: adapter.channelType,
            platformId,
            text: inboundContent.text,
            senderId: senderIdOf(adapter.channelType, inboundContent),
            isGroup: message.isGroup === true,
            agentName: process.env.ASSISTANT_NAME || 'ClawBridge AI',
          })
            .then((reply) =>
              deliveryAdapter.deliver(
                adapter.channelType,
                platformId,
                threadId,
                'chat',
                JSON.stringify({ text: reply }),
              ),
            )
            .catch((err) => log.error('/connect failed', { err }));
          return;
        }

        // Account-linking commands work on any channel, before access checks:
        // a new account must be able to link itself to an existing one.
        if (typeof inboundContent.text === 'string' && isIdentityCommand(inboundContent.text)) {
          const text = inboundContent.text;
          void handleIdentityCommand({
            channelType: adapter.channelType,
            platformId,
            threadId,
            text,
            senderId: senderIdOf(adapter.channelType, inboundContent),
            senderName: typeof inboundContent.sender === 'string' ? inboundContent.sender : null,
            isGroup: message.isGroup === true,
          })
            .then((reply) =>
              reply
                ? deliveryAdapter.deliver(
                    adapter.channelType,
                    platformId,
                    threadId,
                    'chat',
                    JSON.stringify({ text: reply }),
                  )
                : undefined,
            )
            .catch((err) => log.error('Identity command failed', { err }));
          return;
        }

        // A reply of "2" to a numbered question card answers the card (same
        // path as a button click) instead of reaching the agent.
        const answer =
          typeof inboundContent.text === 'string'
            ? interceptNumberedReply(adapter.channelType, platformId, threadId, inboundContent.text)
            : null;
        if (answer) {
          dispatchResponse({
            questionId: answer.questionId,
            value: answer.value,
            userId: senderIdOf(adapter.channelType, inboundContent),
            channelType: adapter.channelType,
            platformId,
            threadId,
          }).catch((err) => log.error('Failed to handle numbered reply', { questionId: answer.questionId, err }));
          return;
        }
        // !stop / !mute / !unmute work while the agent is busy, on every channel.
        if (typeof inboundContent.text === 'string' && isChatControl(inboundContent.text)) {
          void handleChatControl({
            channelType: adapter.channelType,
            platformId,
            threadId,
            text: inboundContent.text,
            senderId: senderIdOf(adapter.channelType, inboundContent),
            isGroup: message.isGroup === true,
          })
            .then((reply) =>
              reply
                ? deliveryAdapter.deliver(
                    adapter.channelType,
                    platformId,
                    threadId,
                    'chat',
                    JSON.stringify({ text: reply }),
                  )
                : undefined,
            )
            .catch((err) => log.error('Chat control failed', { err }));
          return;
        }
        if (mutedUntil(adapter.channelType, platformId)) {
          log.debug('Message dropped — chat is muted', { channelType: adapter.channelType, platformId });
          return;
        }

        routeInbound({
          channelType: adapter.channelType,
          platformId,
          threadId,
          message: {
            id: message.id,
            kind: message.kind,
            content: JSON.stringify(message.content),
            timestamp: message.timestamp,
            isMention: message.isMention,
            isGroup: message.isGroup,
            ...(message.files && message.files.length > 0 ? { files: message.files } : {}),
          },
        }).catch((err) => {
          log.error('Failed to route inbound message', { channelType: adapter.channelType, err });
        });
      },
      onInboundEvent(event) {
        routeInbound(event).catch((err) => {
          log.error('Failed to route inbound event', {
            sourceAdapter: adapter.channelType,
            targetChannelType: event.channelType,
            err,
          });
        });
      },
      onMetadata(platformId, name, isGroup) {
        log.info('Channel metadata discovered', {
          channelType: adapter.channelType,
          platformId,
          name,
          isGroup,
        });
      },
      onStop(platformId, threadId, userId) {
        void stopChatSession(adapter.channelType, platformId, threadId, userId).catch((err) =>
          log.error('Failed to stop session from platform stop button', { err }),
        );
      },
      onAction(questionId, selectedOption, userId) {
        dispatchResponse({
          questionId,
          value: selectedOption,
          userId,
          channelType: adapter.channelType,
          // platformId/threadId aren't surfaced by the current onAction
          // signature — registered handlers look them up from the
          // pending_question / pending_approval row.
          platformId: '',
          threadId: null,
        }).catch((err) => {
          log.error('Failed to handle question response', { questionId, err });
        });
      },
    };
  });

  // Boot warning: check if any DB-registered messaging group has a channel type
  // with no active adapter (missing credentials / not imported).
  {
    const { getAllMessagingGroups } = await import('./db/messaging-groups.js');
    const { getActiveAdapters } = await import('./channels/channel-registry.js');
    const activeChannelTypes = new Set(getActiveAdapters().map((a) => a.channelType));
    const allGroups = getAllMessagingGroups();
    const missingChannels = new Set<string>();
    for (const mg of allGroups) {
      if (!activeChannelTypes.has(mg.channel_type)) {
        missingChannels.add(mg.channel_type);
      }
    }
    for (const ch of missingChannels) {
      const envKey = ch.toUpperCase() + '_BOT_TOKEN';
      log.warn(
        `${ch.charAt(0).toUpperCase() + ch.slice(1)} registered in DB but adapter not active — ${envKey} missing from .env`,
        { channel: ch },
      );
    }
  }

  // 4. Delivery adapter bridge — dispatches to channel adapters
  const deliveryAdapter = {
    async deliver(
      channelType: string,
      platformId: string,
      threadId: string | null,
      kind: string,
      content: string,
      files?: import('./channels/adapter.js').OutboundFile[],
    ): Promise<string | undefined> {
      const adapter = getChannelAdapter(channelType);
      if (!adapter) {
        log.warn('No adapter for channel type', { channelType });
        return;
      }
      const prepared = prepareOutbound(adapter, platformId, threadId, { kind, content: JSON.parse(content), files });
      if (!prepared) return;
      return adapter.deliver(platformId, threadId, prepared);
    },
    async setTyping(channelType: string, platformId: string, threadId: string | null): Promise<void> {
      const adapter = getChannelAdapter(channelType);
      await adapter?.setTyping?.(platformId, threadId);
    },
  };
  setDeliveryAdapter(deliveryAdapter);

  // 5. Start delivery polls
  startActiveDeliveryPoll();
  startSweepDeliveryPoll();
  log.info('Delivery polls started');

  // 5b. Credential proxy (opt-in: CREDENTIAL_PROXY=on / EGRESS_PROXY=on).
  {
    const { PROXY_ENV_KEYS, startCredentialProxy } = await import('./credential-proxy.js');
    const { readEnvFile } = await import('./env.js');
    await startCredentialProxy({ ...readEnvFile([...PROXY_ENV_KEYS]), ...process.env }).catch((err) =>
      log.error('Credential proxy failed to start; containers get credentials directly', { err }),
    );
  }

  // 5c. Local admin console (token-protected, read-only).
  {
    const { startAdminConsole } = await import('./admin-console.js');
    try {
      startAdminConsole();
    } catch (err) {
      log.warn('Admin console not started', { err });
    }
  }

  // 6. Start host sweep
  startHostSweep();
  log.info('Host sweep started');

  // 6b. Start host_exec watcher (file-IPC for the container's host_exec MCP tool).
  startHostExecWatcher();
  // 6c. Integrations watcher (file-IPC for integration_request; credentials stay on the host).
  {
    const { startIntegrationsWatcher } = await import('./modules/integrations/index.js');
    startIntegrationsWatcher();
    const { startShareService } = await import('./modules/share/index.js');
    startShareService();
    const { startHandoffService } = await import('./modules/handoff/index.js');
    startHandoffService();
  }

  // 7. Start health monitoring
  startHealthCheck();

  log.info('ClawBridge running');
}

/** Graceful shutdown. */
async function shutdown(signal: string): Promise<void> {
  log.info('Shutdown signal received', { signal });
  for (const cb of getShutdownCallbacks()) {
    try {
      await cb();
    } catch (err) {
      log.error('Shutdown callback threw', { err });
    }
  }
  stopDeliveryPolls();
  stopHostSweep();
  stopHostExecWatcher();
  stopHealthCheck();
  await teardownChannelAdapters();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
  log.fatal('Startup failed', { err });
  process.exit(1);
});

/**
 * The sender's namespaced id (`<channel>:<id>`), the same way the router
 * stores users: native adapters set `senderId`; Chat SDK bridges put the raw
 * id under `author.userId`.
 */
function senderIdOf(channelType: string, content: { senderId?: unknown; author?: unknown }): string | null {
  const author = content.author as { userId?: unknown } | undefined;
  const raw =
    typeof content.senderId === 'string' ? content.senderId : typeof author?.userId === 'string' ? author.userId : null;
  if (!raw) return null;
  return raw.includes(':') ? raw : `${channelType}:${raw}`;
}
