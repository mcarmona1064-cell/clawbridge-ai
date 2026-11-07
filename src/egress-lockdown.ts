/**
 * Network lockdown for agent containers (EGRESS_LOCKDOWN=on).
 *
 * With the credential/egress proxy alone, a process in the container that
 * ignores HTTPS_PROXY could still open direct connections. Lockdown closes
 * that gap with Docker networking:
 *
 *   agent container ──(internal network "clawbridge-egress", no route out)──▶ relay "egress"
 *   relay ──▶ host.docker.internal:<proxy port> (the host credential/egress proxy)
 *
 * The relay is a tiny TCP forwarder (the agent image running a one-line
 * Node script). It holds no credentials and can reach only the host proxy,
 * which applies the placeholder swap, the private-address block and
 * EGRESS_ALLOWLIST. Lockdown turns the egress proxy on.
 */
import { execFileSync } from 'child_process';

import { log } from './log.js';

export const LOCKDOWN_NETWORK = 'clawbridge-egress';
export const RELAY_NAME = 'clawbridge-egress-relay';
export const RELAY_ALIAS = 'egress';

export type DockerRun = (args: string[]) => string;

const defaultDocker: DockerRun = (args) => execFileSync('docker', args, { stdio: 'pipe', timeout: 60_000 }).toString();

export function lockdownEnabled(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): boolean {
  return env.EGRESS_LOCKDOWN === 'on';
}

/** The relay's forwarding script: listen on `port`, forward every connection to the host proxy. */
export function relayScript(port: number): string {
  return (
    `const net=require('net');net.createServer(c=>{const u=net.connect(${port},'host.docker.internal');` +
    `c.pipe(u);u.pipe(c);u.on('error',()=>c.destroy());c.on('error',()=>u.destroy())}).listen(${port})`
  );
}

/**
 * Create the internal network and start the relay if they are missing.
 * Idempotent. Returns false (and logs) when Docker refuses, so callers can
 * fall back to the unlocked setup instead of failing every spawn.
 */
export function ensureLockdown(image: string, proxyPort: number, docker: DockerRun = defaultDocker): boolean {
  try {
    const networks = docker(['network', 'ls', '--format', '{{.Name}}']).split('\n');
    if (!networks.includes(LOCKDOWN_NETWORK)) docker(['network', 'create', '--internal', LOCKDOWN_NETWORK]);

    const running = docker(['ps', '--filter', `name=^${RELAY_NAME}$`, '--format', '{{.Names}}']).trim();
    if (running !== RELAY_NAME) {
      docker(['rm', '-f', RELAY_NAME]);
      docker([
        'run',
        '-d',
        '--name',
        RELAY_NAME,
        '--restart',
        'unless-stopped',
        '--add-host=host.docker.internal:host-gateway',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--memory',
        '64m',
        '--entrypoint',
        'node',
        image,
        '-e',
        relayScript(proxyPort),
      ]);
      docker(['network', 'connect', '--alias', RELAY_ALIAS, LOCKDOWN_NETWORK, RELAY_NAME]);
    }
    return true;
  } catch (err) {
    log.error('Egress lockdown could not be set up; containers will use the normal network', { err });
    return false;
  }
}

/** docker run arguments that put an agent container on the locked network. */
export function lockdownNetworkArgs(): string[] {
  return ['--network', LOCKDOWN_NETWORK];
}

/** Base URL containers use for the proxy when locked down. */
export function lockdownProxyBase(port: number): string {
  return `http://${RELAY_ALIAS}:${port}`;
}
