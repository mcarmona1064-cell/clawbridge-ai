/**
 * Slack Socket Mode client — receive events over a WebSocket instead of a
 * public webhook URL. Needs an app-level token (xapp-…) with the
 * `connections:write` scope and Socket Mode turned on in the app settings.
 *
 * Protocol: POST apps.connections.open → wss URL. Slack sends `hello`, then
 * envelopes `{ envelope_id, type, payload }`; each envelope is acked by
 * sending `{ envelope_id }` back within 3 seconds. `disconnect` (refresh,
 * link disabled) and socket closes reconnect with backoff.
 */
import { log } from '../log.js';

export interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'close' | 'error', fn: () => void): void;
  addEventListener(type: 'message', fn: (ev: { data: unknown }) => void): void;
}

export type SocketFactory = (url: string) => SocketLike;

export interface SocketModeHandlers {
  /** Events API payload (`event_callback`), same shape as the webhook body. */
  onEvents(payload: Record<string, unknown>): void;
  /** Interactivity payload (`block_actions`, …). */
  onInteractive(payload: Record<string, unknown>): void;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const MAX_BACKOFF_MS = 30_000;

export class SlackSocketMode {
  private socket: SocketLike | null = null;
  private stopped = false;
  private attempts = 0;
  private connectedFlag = false;

  constructor(
    private readonly appToken: string,
    private readonly handlers: SocketModeHandlers,
    private readonly socketFactory: SocketFactory = defaultSocketFactory,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  get connected(): boolean {
    return this.connectedFlag;
  }

  /** Open the first connection. Resolves once Slack says hello (or rejects on a bad token). */
  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.connectedFlag = false;
    this.socket?.close();
    this.socket = null;
  }

  private async openUrl(): Promise<string> {
    const res = await this.fetchImpl('https://slack.com/api/apps.connections.open', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.appToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; url?: string; error?: string };
    if (!res.ok || !body.ok || !body.url) {
      throw new Error(`Slack apps.connections.open failed: ${body.error ?? `HTTP ${res.status}`}`);
    }
    return body.url;
  }

  private async connect(): Promise<void> {
    const url = await this.openUrl();
    await new Promise<void>((resolve, reject) => {
      const socket = this.socketFactory(url);
      this.socket = socket;
      let greeted = false;
      socket.addEventListener('message', (ev) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
        } catch {
          return;
        }
        if (msg['type'] === 'hello') {
          greeted = true;
          this.attempts = 0;
          this.connectedFlag = true;
          log.info('[slack] Socket Mode connected');
          resolve();
          return;
        }
        if (msg['type'] === 'disconnect') {
          log.info('[slack] Socket Mode disconnect requested', { reason: msg['reason'] });
          socket.close();
          return;
        }
        this.handleEnvelope(socket, msg);
      });
      socket.addEventListener('close', () => {
        this.connectedFlag = false;
        if (!greeted) reject(new Error('Slack Socket Mode closed before hello'));
        if (!this.stopped && this.socket === socket) void this.reconnect();
      });
      socket.addEventListener('error', () => {
        log.warn('[slack] Socket Mode socket error');
      });
    });
  }

  private handleEnvelope(socket: SocketLike, msg: Record<string, unknown>): void {
    const envelopeId = msg['envelope_id'] as string | undefined;
    // Ack first: Slack redelivers anything not acked within 3 seconds.
    if (envelopeId) socket.send(JSON.stringify({ envelope_id: envelopeId }));
    const payload = (msg['payload'] ?? {}) as Record<string, unknown>;
    try {
      if (msg['type'] === 'events_api') this.handlers.onEvents(payload);
      else if (msg['type'] === 'interactive') this.handlers.onInteractive(payload);
    } catch (err) {
      log.error('[slack] Socket Mode handler threw', { err });
    }
  }

  private async reconnect(): Promise<void> {
    while (!this.stopped) {
      const wait = Math.min(1000 * 2 ** this.attempts, MAX_BACKOFF_MS);
      this.attempts++;
      await this.sleep(wait);
      if (this.stopped) return;
      try {
        await this.connect();
        return;
      } catch (err) {
        log.warn('[slack] Socket Mode reconnect failed', { err: (err as Error).message, attempt: this.attempts });
      }
    }
  }
}

function defaultSocketFactory(url: string): SocketLike {
  const WS = (globalThis as { WebSocket?: new (url: string) => SocketLike }).WebSocket;
  if (!WS) throw new Error('Slack Socket Mode needs Node 22+ (global WebSocket)');
  return new WS(url);
}
