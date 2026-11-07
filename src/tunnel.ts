/**
 * `clawbridge-ai tunnel` — a public HTTPS URL for channels that need a
 * webhook (WhatsApp Cloud API, Slack webhook mode), without opening ports.
 *
 * Runs a Cloudflare quick tunnel to the local webhook server and prints the
 * exact callback URLs to paste. Quick-tunnel URLs change on every restart;
 * for a permanent URL, set up a named Cloudflare tunnel or any reverse proxy
 * and point it at the same port. Webhook signatures (WHATSAPP_APP_SECRET,
 * SLACK_SIGNING_SECRET) are what keep a public URL safe.
 */
import { spawn, spawnSync } from 'child_process';

export function webhookPort(): number {
  return parseInt(process.env.WEBHOOK_PORT || '3000', 10);
}

/** Pull the public URL out of cloudflared's log output. */
export function parseTunnelUrl(output: string): string | null {
  const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(output);
  return m ? m[0] : null;
}

export function callbackUrls(base: string): Record<string, string> {
  return {
    WhatsApp: `${base}/webhook/whatsapp`,
    'Slack (webhook mode)': `${base}/webhook/slack`,
  };
}

export function hasCloudflared(): boolean {
  return spawnSync('cloudflared', ['--version'], { stdio: 'ignore' }).status === 0;
}

export async function runTunnel(): Promise<number> {
  if (!hasCloudflared()) {
    console.log('cloudflared is not installed. Install it, then run this again:');
    console.log(
      process.platform === 'darwin' ? '  brew install cloudflared' : '  https://developers.cloudflare.com/cloudflared/',
    );
    return 1;
  }
  const port = webhookPort();
  console.log(`Opening a public tunnel to http://localhost:${port} …`);
  const child = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let printed = false;
  const onData = (chunk: Buffer) => {
    if (printed) return;
    const url = parseTunnelUrl(chunk.toString());
    if (!url) return;
    printed = true;
    console.log('\nTunnel ready. Paste these where each platform asks for a callback URL:\n');
    for (const [name, u] of Object.entries(callbackUrls(url))) console.log(`  ${name.padEnd(22)} ${u}`);
    console.log('\nWhatsApp: Meta app → WhatsApp → Configuration → Callback URL, and the verify token');
    console.log('from WHATSAPP_WEBHOOK_VERIFY_TOKEN. Subscribe to the "messages" field.');
    console.log('\nThis URL changes when the tunnel restarts. Keep this window open; Ctrl+C to stop.');
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  return new Promise((resolve) => {
    process.on('SIGINT', () => child.kill('SIGINT'));
    child.on('exit', (code) => resolve(code ?? 0));
  });
}
