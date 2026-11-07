/**
 * Upgrade an existing ClawBridge (clawbridge / clawbridge-agent) or
 * ClawBridge Codex (clawbridge-codex) install to ClawBridge AI.
 *
 * These are earlier releases of this same product, so the data format is
 * the same: the central DB (data/v2.db), the per-session DBs
 * (data/v2-sessions/), agent groups (groups/) and .env all carry over. New
 * tables are added by the normal migrations on first start (they are keyed
 * by name, so an old DB simply gains the ones it is missing).
 *
 * What does change, and what this module handles:
 *   - The old service (launchd / systemd) points at the old package and has a
 *     different label, so it would keep running beside the new one and both
 *     would answer the same bots. It is stopped and its file moved into the
 *     backup.
 *   - ~/.clawbridge links (container/, src/shared, docker-compose.yml) point
 *     into the old package. They are repointed at this one.
 *   - .env gains the dual-provider keys (DEFAULT_AGENT_PROVIDER,
 *     ENABLED_AGENT_PROVIDERS) and CREDENTIAL_PROXY, and loses image names
 *     pinned to the old package. Every other line is kept as it was.
 *   - Installs that ran from a source checkout (data inside the checkout)
 *     are copied into ~/.clawbridge first; the checkout is left untouched.
 *
 * Everything that is changed is backed up first, and `rollbackLegacyUpgrade`
 * puts it back.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import Database from 'better-sqlite3';

import { getContainerImageBase } from '../install-slug.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type LegacyKind = 'clawbridge' | 'clawbridge-codex';

/** Package names this product has shipped under before clawbridge-ai. */
export const LEGACY_PACKAGES: Record<string, LegacyKind> = {
  clawbridge: 'clawbridge',
  'clawbridge-agent': 'clawbridge',
  'clawbridge-codex': 'clawbridge-codex',
};

export const LEGACY_LABEL: Record<LegacyKind, string> = {
  clawbridge: 'ClawBridge',
  'clawbridge-codex': 'ClawBridge Codex',
};

/** Written into ~/.clawbridge once it belongs to clawbridge-ai. */
export const AI_MARKER_FILE = '.clawbridge-ai.json';

export interface LegacyService {
  manager: 'launchd' | 'systemd';
  /** systemd only: a user unit, or a system unit in /etc/systemd/system (stopping it needs root). */
  scope: 'user' | 'system';
  /** launchd label or systemd unit name. */
  label: string;
  file: string;
  /** CONTAINER_IMAGE the old service ran, when it set one. */
  image?: string;
}

/** An old install started by the nohup fallback, with no service manager. */
export interface LegacyProcess {
  pid: number;
  pidFile: string;
  /** start-clawbridge.sh, used to start it again on rollback. */
  wrapper: string | null;
}

export type LinkStatus = 'ok' | 'legacy' | 'broken' | 'missing' | 'not-a-link';

export interface RuntimeLink {
  /** Path relative to the data dir: container, src/shared, docker-compose.yml. */
  name: string;
  target: string | null;
  status: LinkStatus;
}

export interface LegacyInstall {
  kind: LegacyKind;
  /** Where the old install keeps .env, data/ and groups/. */
  dataDir: string;
  /** True when dataDir is ~/.clawbridge itself (upgrade in place). */
  inPlace: boolean;
  packageName?: string;
  version?: string;
  /** Provider the old install ran its agents on. */
  previousProvider: 'claude' | 'codex';
  services: LegacyService[];
  processes: LegacyProcess[];
  links: RuntimeLink[];
  groups: number;
  sessions: number;
  hasEnv: boolean;
}

export interface LegacyContext {
  home?: string;
  platform?: NodeJS.Platform;
  /** Where system-wide systemd units live (default /etc/systemd/system). */
  systemUnitDir?: string;
  /** Running as root, so system services can be stopped. */
  isRoot?: boolean;
  /** Is this pid alive? Injected by tests. */
  isAlive?: (pid: number) => boolean;
  /** The command line of a pid, or null. Injected by tests. */
  commandOf?: (pid: number) => string | null;
}

export interface UpgradeOptions extends LegacyContext {
  /** Root of the clawbridge-ai package the links should point at. */
  packageRoot: string;
  /** Describe the steps without changing anything. */
  dryRun?: boolean;
  /** Runs service-manager commands. Injected by tests. */
  run?: Run;
  /** Stops a pid; true once it has exited. Injected by tests. */
  stopProcess?: (pid: number) => boolean;
  now?: () => Date;
}

export type Run = (cmd: string, args: string[]) => { status: number | null; stdout?: string };

export interface UpgradeReport {
  dataDir: string;
  backupDir: string | null;
  steps: string[];
  /** What the owner should still do (build image, start service, tidy up). */
  next: string[];
}

interface BackupManifest {
  kind: LegacyKind;
  version?: string;
  sourceDir: string;
  inPlace: boolean;
  createdAt: string;
  /** Set once every step finished. An unfinished backup blocks a new upgrade. */
  completed: boolean;
  envBackedUp: boolean;
  /** The upgrade wrote a .env where there was none; rollback removes it. */
  envCreated: boolean;
  /** In place: .env was a symlink to this target; rollback recreates the link. */
  envLink?: string;
  /** In place: databases backed up, relative to the data dir. */
  databases: string[];
  /** In place: group files backed up (relative to the data dir). */
  groupFiles: string[];
  /** In place: tracked group files that did not exist yet; rollback removes them. */
  groupFilesAbsent: string[];
  links: Array<{ name: string; target: string | null; wasLink: boolean }>;
  services: Array<LegacyService & { backupFile: string }>;
  processes: LegacyProcess[];
  /** Copy mode: entries this upgrade put in ~/.clawbridge, recorded before copying. */
  created: string[];
  /** Copy mode: entries already in ~/.clawbridge that were moved into the backup. */
  moved: string[];
  /** Agent groups whose own image was moved onto the new image base. */
  retaggedGroups: string[];
}

// ─── Small helpers ───────────────────────────────────────────────────────────

function homeOf(ctx: LegacyContext): string {
  return ctx.home ?? os.homedir();
}

function aiHome(ctx: LegacyContext): string {
  return path.join(homeOf(ctx), '.clawbridge');
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

export function parseEnv(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!m) continue;
    map.set(m[1], m[2].trim().replace(/^['"]|['"]$/g, ''));
  }
  return map;
}

function readPackage(dir: string): { name?: string; version?: string } | null {
  const text = readText(path.join(dir, 'package.json'));
  if (!text) return null;
  try {
    return JSON.parse(text) as { name?: string; version?: string };
  } catch {
    return null;
  }
}

/** Walk up from a file or directory to the nearest package.json. */
function owningPackage(p: string, maxUp = 5): { root: string; name?: string; version?: string } | null {
  let dir = p;
  try {
    if (!fs.statSync(p).isDirectory()) dir = path.dirname(p);
  } catch {
    dir = path.dirname(p);
  }
  for (let i = 0; i <= maxUp; i++) {
    const pkg = readPackage(dir);
    if (pkg) return { root: dir, ...pkg };
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** Legacy package named by a path segment, for paths whose package is gone. */
function legacyFromPathText(p: string): { kind: LegacyKind; version?: string } | null {
  const m = p.match(/(?:^|[/\\])(clawbridge-codex|clawbridge-agent|clawbridge)(?:-(\d+\.\d+\.\d+))?(?=$|[/\\])/);
  if (!m) return null;
  // A bare "clawbridge" segment is only a package name inside node_modules or runtime/.
  if (m[1] === 'clawbridge' && !/(node_modules|runtime)[/\\]clawbridge(-\d|[/\\]|$)/.test(p)) return null;
  return { kind: LEGACY_PACKAGES[m[1]], version: m[2] };
}

/** Which product a file path belongs to: a legacy one, clawbridge-ai, or unknown. */
function productOf(p: string): { kind: LegacyKind | 'ai'; version?: string } | null {
  const pkg = owningPackage(p);
  if (pkg?.name === 'clawbridge-ai') return { kind: 'ai', version: pkg.version };
  if (pkg?.name && LEGACY_PACKAGES[pkg.name]) return { kind: LEGACY_PACKAGES[pkg.name], version: pkg.version };
  if (/(?:^|[/\\])clawbridge-ai(?=$|[/\\-])/.test(p)) return { kind: 'ai' };
  return legacyFromPathText(p);
}

// ─── Runtime links ───────────────────────────────────────────────────────────

const LINK_NAMES = ['container', path.join('src', 'shared'), 'docker-compose.yml'] as const;

/** Where each ~/.clawbridge link should point inside a clawbridge-ai package. */
export function linkTargets(packageRoot: string): Record<string, string> {
  const distShared = path.join(packageRoot, 'dist', 'shared');
  return {
    container: path.join(packageRoot, 'container'),
    [path.join('src', 'shared')]: fs.existsSync(distShared) ? distShared : path.join(packageRoot, 'src', 'shared'),
    'docker-compose.yml': path.join(packageRoot, 'integrations', 'docker-compose.yml'),
  };
}

function inspectLinks(dataDir: string): RuntimeLink[] {
  return LINK_NAMES.map((name) => {
    const full = path.join(dataDir, name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(full);
    } catch {
      return { name, target: null, status: 'missing' as const };
    }
    if (!stat.isSymbolicLink()) return { name, target: null, status: 'not-a-link' as const };
    const raw = fs.readlinkSync(full);
    const target = path.resolve(path.dirname(full), raw);
    if (!fs.existsSync(target)) {
      return { name, target, status: legacyFromPathText(target) ? ('legacy' as const) : ('broken' as const) };
    }
    const product = productOf(target);
    return { name, target, status: product && product.kind !== 'ai' ? ('legacy' as const) : ('ok' as const) };
  });
}

// ─── Services and processes ──────────────────────────────────────────────────

function plistValue(xml: string, key: string): string | undefined {
  const m = xml.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
  return m?.[1];
}

function plistStrings(xml: string): string[] {
  return [...xml.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
}

function unitValues(text: string): string[] {
  return text
    .split('\n')
    .flatMap((l) => l.replace(/^[A-Za-z]+=/, '').split(/\s+/))
    .filter(Boolean);
}

/** Resolve symlinks where the path exists, so two spellings of one folder compare equal. */
function canonical(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Which product a service runs: clawbridge-ai, a legacy package, or neither. */
function programProduct(values: string[]): 'ai' | 'legacy' | null {
  let legacy = false;
  for (const v of values) {
    if (!/\.(c|m)?js$/.test(v) && !/[/\\](dist|runtime|node_modules)[/\\]/.test(v)) continue;
    const product = productOf(v);
    if (product?.kind === 'ai') return 'ai';
    if (product) legacy = true;
  }
  return legacy ? 'legacy' : null;
}

function scanServices(dataDir: string, ctx: LegacyContext, want: 'ai' | 'legacy'): LegacyService[] {
  const home = homeOf(ctx);
  const platform = ctx.platform ?? process.platform;
  const target = canonical(dataDir);
  const refersToInstall = (values: string[]) =>
    values.some((v) => {
      if (!v.startsWith('/')) return false;
      const c = canonical(v);
      return c === target || c.startsWith(target + path.sep);
    });
  const dirs: Array<{ dir: string; manager: LegacyService['manager']; scope: LegacyService['scope'] }> =
    platform === 'darwin'
      ? [{ dir: path.join(home, 'Library', 'LaunchAgents'), manager: 'launchd', scope: 'user' }]
      : platform === 'linux'
        ? [
            { dir: path.join(home, '.config', 'systemd', 'user'), manager: 'systemd', scope: 'user' },
            { dir: ctx.systemUnitDir ?? '/etc/systemd/system', manager: 'systemd', scope: 'system' },
          ]
        : [];
  const out: LegacyService[] = [];
  for (const { dir, manager, scope } of dirs) {
    const ext = manager === 'launchd' ? '.plist' : '.service';
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(ext) && f.toLowerCase().includes('clawbridge'));
    } catch {
      continue; // no such dir
    }
    for (const f of files) {
      const file = path.join(dir, f);
      const text = readText(file);
      if (!text) continue;
      const values = manager === 'launchd' ? plistStrings(text) : unitValues(text);
      if (!refersToInstall(values) || programProduct(values) !== want) continue;
      const label =
        manager === 'launchd' ? (plistValue(text, 'Label') ?? f.slice(0, -ext.length)) : f.slice(0, -ext.length);
      const image =
        manager === 'launchd' ? plistValue(text, 'CONTAINER_IMAGE') : text.match(/CONTAINER_IMAGE=([^\s"]+)/)?.[1];
      out.push({ manager, scope, label, file, image });
    }
  }
  return out;
}

/** Old services for the install at dataDir: they work in it and run a legacy package. */
export function findLegacyServices(dataDir: string, ctx: LegacyContext = {}): LegacyService[] {
  return scanServices(dataDir, ctx, 'legacy');
}

/** ClawBridge AI's own services for the install at dataDir. */
export function findAiServices(dataDir: string, ctx: LegacyContext = {}): LegacyService[] {
  return scanServices(dataDir, ctx, 'ai');
}

function uid(): string {
  try {
    return String(os.userInfo().uid);
  } catch {
    return '501';
  }
}

function scopeArgs(s: LegacyService): string[] {
  return s.manager === 'systemd' && s.scope === 'user' ? ['--user'] : [];
}

export type ServiceState = 'running' | 'stopped' | 'unknown';

/**
 * Whether a service is running, judged only on positive evidence: launchd
 * exit 113 ("could not find service") or systemd ActiveState inactive/failed
 * mean stopped. Anything else that isn't clearly running is unknown.
 */
export function serviceState(s: LegacyService, run: Run = defaultRun): { state: ServiceState; raw: string } {
  if (s.manager === 'launchd') {
    const r = run('launchctl', ['print', `gui/${uid()}/${s.label}`]);
    return { state: r.status === 0 ? 'running' : r.status === 113 ? 'stopped' : 'unknown', raw: String(r.status) };
  }
  const r = run('systemctl', [...scopeArgs(s), 'show', '-p', 'ActiveState', '--value', `${s.label}.service`]);
  const raw = (r.stdout ?? '').trim();
  if (r.status !== 0 || !raw) return { state: 'unknown', raw };
  if (raw === 'inactive' || raw === 'failed') return { state: 'stopped', raw };
  if (['active', 'activating', 'deactivating', 'reloading'].includes(raw)) return { state: 'running', raw };
  return { state: 'unknown', raw };
}

/** Stop a service and confirm it stopped. Throws, changing nothing else, unless it is confirmed stopped. */
function stopService(s: LegacyService, run: Run): void {
  if (s.manager === 'launchd') run('launchctl', ['bootout', `gui/${uid()}/${s.label}`]);
  else run('systemctl', [...scopeArgs(s), 'disable', '--now', `${s.label}.service`]);
  let st = serviceState(s, run);
  // A systemd unit can take a while to stop (it shuts its containers down).
  for (let i = 0; i < 60 && st.raw === 'deactivating'; i++) {
    sleepMs(2000);
    st = serviceState(s, run);
  }
  if (st.state === 'stopped') return;
  const how =
    s.manager === 'launchd'
      ? `launchctl bootout gui/$(id -u)/${s.label}`
      : `systemctl ${scopeArgs(s).join(' ')} disable --now ${s.label}`.replace(/\s+/g, ' ');
  throw new Error(
    st.state === 'running'
      ? `Couldn't stop the service ${s.label}. Stop it with \`${how}\`, then run this again.`
      : `Couldn't confirm the service ${s.label} stopped (${s.manager} said "${st.raw || 'nothing'}"). Stop it with \`${how}\`, then run this again.`,
  );
}

function startService(s: LegacyService, run: Run): void {
  if (s.manager === 'launchd') {
    run('launchctl', ['bootstrap', `gui/${uid()}`, s.file]);
  } else {
    run('systemctl', [...scopeArgs(s), 'daemon-reload']);
    run('systemctl', [...scopeArgs(s), 'enable', '--now', `${s.label}.service`]);
  }
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function defaultCommandOf(pid: number): string | null {
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf-8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function defaultStopProcess(pid: number, isAlive: (pid: number) => boolean): boolean {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  for (let i = 0; i < 50 && isAlive(pid); i++) sleepMs(200);
  return !isAlive(pid);
}

/**
 * Installs started with the nohup fallback (start-clawbridge.sh writes
 * clawbridge.pid into the package root). A pid only counts when that process
 * is alive and is running code from the same root, so a stale pid file never
 * points at an unrelated process.
 */
export function findPidFileProcesses(roots: string[], ctx: LegacyContext = {}): LegacyProcess[] {
  const isAlive = ctx.isAlive ?? defaultIsAlive;
  const commandOf = ctx.commandOf ?? defaultCommandOf;
  const out: LegacyProcess[] = [];
  for (const root of new Set(roots.map(canonical))) {
    const pidFile = path.join(root, 'clawbridge.pid');
    const pid = Number.parseInt(readText(pidFile)?.trim() ?? '', 10);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || !isAlive(pid)) continue;
    if (!commandOf(pid)?.includes(root)) continue;
    const wrapper = path.join(root, 'start-clawbridge.sh');
    out.push({ pid, pidFile, wrapper: fs.existsSync(wrapper) ? wrapper : null });
  }
  return out;
}

// ─── Detection ───────────────────────────────────────────────────────────────

function countDirs(dir: string, filter: (name: string) => boolean = () => true): number {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && filter(e.name)).length;
  } catch {
    return 0;
  }
}

function countSessions(dataDir: string): number {
  const root = path.join(dataDir, 'data', 'v2-sessions');
  let n = 0;
  try {
    for (const ag of fs.readdirSync(root, { withFileTypes: true })) {
      if (ag.isDirectory()) n += countDirs(path.join(root, ag.name), (s) => s.startsWith('sess-'));
    }
  } catch {
    /* no sessions */
  }
  return n;
}

function runtimeDirs(dataDir: string): string[] {
  try {
    return fs
      .readdirSync(path.join(dataDir, 'runtime'))
      .map((e) => path.join(dataDir, 'runtime', e))
      .filter((d) => legacyFromPathText(d));
  } catch {
    return [];
  }
}

/** The clawbridge-ai package ~/.clawbridge's links point at, if any. */
function aiPackageRootFromLinks(dest: string): string | null {
  for (const l of inspectLinks(dest)) {
    if (l.status !== 'ok' || !l.target) continue;
    const pkg = owningPackage(l.target);
    if (pkg?.name === 'clawbridge-ai') return pkg.root;
  }
  return null;
}

/** The folder ~/.clawbridge was imported from, per its marker. */
function importedSource(ctx: LegacyContext): string | null {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(aiHome(ctx), AI_MARKER_FILE), 'utf-8')) as { source?: string };
    return marker.source ? canonical(marker.source) : null;
  } catch {
    return null;
  }
}

function runtimeVersion(dataDir: string): { kind: LegacyKind; version?: string } | null {
  try {
    for (const e of fs.readdirSync(path.join(dataDir, 'runtime'))) {
      const hit = legacyFromPathText(path.join(dataDir, 'runtime', e));
      if (hit) return hit;
    }
  } catch {
    /* no runtime dir */
  }
  return null;
}

/**
 * Inspect one directory. Returns null when it isn't an old ClawBridge install
 * (including when it already belongs to clawbridge-ai).
 */
export function inspectLegacyDir(dir: string, ctx: LegacyContext = {}): LegacyInstall | null {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
  const dataDir = canonical(dir);
  const home = canonical(aiHome(ctx));
  if (fs.existsSync(path.join(dataDir, AI_MARKER_FILE))) return null;
  // A checkout that was already imported into ~/.clawbridge is left as it was;
  // offering it again would import it a second time.
  if (dataDir !== home && importedSource(ctx) === dataDir) return null;

  const envText = readText(path.join(dataDir, '.env'));
  const hasDb = fs.existsSync(path.join(dataDir, 'data', 'v2.db'));
  if (envText === null && !hasDb) return null;
  const env = parseEnv(envText ?? '');

  const pkg = readPackage(dataDir);
  if (pkg?.name === 'clawbridge-ai') return null;
  const isCheckout = Boolean(pkg?.name && LEGACY_PACKAGES[pkg.name]);
  if (pkg && !isCheckout) return null; // some other project

  const links = inspectLinks(dataDir);
  const services = findLegacyServices(dataDir, ctx);
  const runtime = runtimeVersion(dataDir);
  const roots = [dataDir, ...runtimeDirs(dataDir)];
  for (const l of links) {
    if (l.status === 'legacy' && l.target) {
      const pkgRoot = owningPackage(l.target)?.root;
      if (pkgRoot) roots.push(pkgRoot);
    }
  }
  const processes = findPidFileProcesses(roots, ctx);

  // Evidence, strongest first.
  let kind: LegacyKind | undefined = isCheckout ? LEGACY_PACKAGES[pkg!.name!] : undefined;
  let version = isCheckout ? pkg!.version : undefined;
  let packageName = isCheckout ? pkg!.name : undefined;
  const legacyLink = links.find((l) => l.status === 'legacy' && l.target);
  if (!kind && legacyLink) {
    const product = productOf(legacyLink.target!);
    if (product && product.kind !== 'ai') {
      kind = product.kind;
      version = product.version;
      packageName =
        owningPackage(legacyLink.target!)?.name ?? (kind === 'clawbridge-codex' ? 'clawbridge-codex' : undefined);
    }
  }
  const declared = env.get('AGENT_PROVIDER');
  const hasDualKeys = env.has('ENABLED_AGENT_PROVIDERS');
  // A leftover runtime/ copy only counts while .env is still the old one.
  if (!kind && runtime && !hasDualKeys) ({ kind, version } = runtime);
  if (!kind && services.length) {
    for (const s of services) {
      const values = plistStrings(readText(s.file) ?? '').concat((readText(s.file) ?? '').split(/\s+/));
      const hit = values.map(productOf).find((p) => p && p.kind !== 'ai');
      if (hit && hit.kind !== 'ai') {
        kind = hit.kind;
        version = hit.version;
        break;
      }
    }
  }

  if (!kind) {
    // No package evidence: fall back to the .env the old wizards wrote.
    if (hasDualKeys) return null; // written by clawbridge-ai
    if (declared && declared !== 'codex') kind = 'clawbridge';
    else if (declared === 'codex' && hasDb) kind = 'clawbridge-codex';
    else return null; // an empty or unrelated data dir
  }

  const previous = env.get('DEFAULT_AGENT_PROVIDER') ?? declared;
  const previousProvider: 'claude' | 'codex' =
    previous === 'claude' || previous === 'codex' ? previous : kind === 'clawbridge-codex' ? 'codex' : 'claude';

  return {
    kind,
    dataDir,
    inPlace: dataDir === home,
    packageName,
    version,
    previousProvider,
    services,
    processes,
    links,
    groups: countDirs(path.join(dataDir, 'groups'), (n) => n !== 'global'),
    sessions: countSessions(dataDir),
    hasEnv: envText !== null,
  };
}

/** Places an old install keeps its data, most likely first. */
export function legacyCandidates(ctx: LegacyContext = {}): string[] {
  const home = homeOf(ctx);
  return [
    path.join(home, '.clawbridge'),
    path.join(home, '.local', 'share', 'clawbridge-codex', 'source'),
    path.join(home, '.local', 'share', 'clawbridge-agent', 'source'),
    path.join(home, '.local', 'share', 'clawbridge', 'source'),
    path.join(home, 'clawbridge-codex'),
    path.join(home, 'clawbridge-agent'),
    path.join(home, 'clawbridge'),
  ];
}

/** Every old install found, in candidate order. */
export function findLegacyInstalls(ctx: LegacyContext = {}): LegacyInstall[] {
  const out: LegacyInstall[] = [];
  for (const dir of legacyCandidates(ctx)) {
    const hit = inspectLegacyDir(dir, ctx);
    // A checkout only counts when it actually holds data.
    if (hit && (hit.inPlace || fs.existsSync(path.join(hit.dataDir, 'data', 'v2.db')))) out.push(hit);
  }
  return out;
}

export function describeInstall(i: LegacyInstall, home = os.homedir()): string {
  const tilde = (p: string) => (p.startsWith(home) ? '~' + p.slice(home.length) : p);
  return `${LEGACY_LABEL[i.kind]}${i.version ? ' ' + i.version : ''} at ${tilde(i.dataDir)}`;
}

// ─── .env ────────────────────────────────────────────────────────────────────

/**
 * Upgrade an old .env for clawbridge-ai. Every existing line is kept, except
 * image names pinned to the old package, which are commented out. Missing
 * keys are added in one block at the end.
 */
export function upgradeLegacyEnv(
  text: string,
  opts: { kind: LegacyKind; version?: string; previousProvider: 'claude' | 'codex'; codexAuth: boolean; date: Date },
): string {
  const env = parseEnv(text);
  const lines = text.replace(/\s+$/, '').split('\n');
  const kept = lines.map((line) => {
    const m = line.match(/^\s*(CONTAINER_IMAGE|CONTAINER_IMAGE_BASE)\s*=(.*)$/);
    if (m && /^['"]?clawbridge(-codex|-agent)?-v2-/.test(m[2].trim())) {
      return `# ${line}   (old image; clawbridge-ai builds its own)`;
    }
    // The legacy marker read by older wizards must say codex so this install
    // is never offered for migration again.
    if (/^\s*AGENT_PROVIDER\s*=/.test(line) && env.get('AGENT_PROVIDER') !== 'codex') return 'AGENT_PROVIDER=codex';
    return line;
  });

  const hasClaude = Boolean(env.get('CLAUDE_CODE_OAUTH_TOKEN') || env.get('ANTHROPIC_API_KEY'));
  const enabled = new Set<'claude' | 'codex'>([opts.previousProvider]);
  if (hasClaude) enabled.add('claude');
  if (opts.codexAuth || opts.kind === 'clawbridge-codex') enabled.add('codex');
  const ordered = (['claude', 'codex'] as const).filter((p) => enabled.has(p));

  const add: string[] = [];
  if (!env.has('DEFAULT_AGENT_PROVIDER')) add.push(`DEFAULT_AGENT_PROVIDER=${opts.previousProvider}`);
  if (!env.has('ENABLED_AGENT_PROVIDERS')) add.push(`ENABLED_AGENT_PROVIDERS=${ordered.join(',')}`);
  if (!env.has('AGENT_PROVIDER')) add.push('AGENT_PROVIDER=codex');
  if (!env.has('CREDENTIAL_PROXY')) add.push('CREDENTIAL_PROXY=on');

  if (add.length) {
    kept.push(
      '',
      `# Added when upgrading from ${LEGACY_LABEL[opts.kind]}${opts.version ? ' ' + opts.version : ''} (${opts.date.toISOString().slice(0, 10)}).`,
      '# Both providers ship in the agent image; switch any agent with /provider.',
      ...add,
    );
  }
  return kept.join('\n') + '\n';
}

// ─── Upgrade ─────────────────────────────────────────────────────────────────

/** Thrown by the upgrade. `backupDir` is the backup this run made, or null when nothing was changed. */
export class LegacyUpgradeError extends Error {
  constructor(
    message: string,
    readonly backupDir: string | null,
  ) {
    super(message);
    this.name = 'LegacyUpgradeError';
  }
}

function defaultRun(cmd: string, args: string[]): { status: number | null; stdout?: string } {
  try {
    // Stopping a unit can take a while; systemd's own stop timeout is 90s.
    const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8', timeout: 120_000 });
    return { status: r.status, stdout: r.stdout };
  } catch {
    return { status: null };
  }
}

/** Upgrade backups live apart from the OpenClaw importer's migration-backup/. */
function backupRoot(ctx: LegacyContext): string {
  return path.join(aiHome(ctx), 'upgrade-backup');
}

function tildeFor(ctx: LegacyContext): (p: string) => string {
  const home = homeOf(ctx);
  return (p) => (p.startsWith(home) ? '~' + p.slice(home.length) : p);
}

function readManifest(dir: string): BackupManifest | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8')) as BackupManifest;
  } catch {
    return null;
  }
}

function legacyBackups(ctx: LegacyContext): string[] {
  const root = backupRoot(ctx);
  try {
    return fs
      .readdirSync(root)
      .filter((d) => d.startsWith('legacy-') && readManifest(path.join(root, d)))
      .sort()
      .map((d) => path.join(root, d));
  } catch {
    return [];
  }
}

/** The newest backup an upgrade made that has not been rolled back. */
export function latestLegacyBackup(ctx: LegacyContext = {}): string | null {
  return legacyBackups(ctx).at(-1) ?? null;
}

/** A backup from an upgrade that stopped partway (and was not rolled back). */
export function unfinishedLegacyBackup(ctx: LegacyContext = {}): string | null {
  return (
    legacyBackups(ctx)
      .filter((d) => !readManifest(d)!.completed)
      .at(-1) ?? null
  );
}

export function describeBackup(
  dir: string,
): { kind: LegacyKind; version?: string; createdAt: string; completed: boolean } | null {
  const m = readManifest(dir);
  return m ? { kind: m.kind, version: m.version, createdAt: m.createdAt, completed: m.completed } : null;
}

function listDatabases(dataDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(full, depth + 1);
      else if (e.isFile() && e.name.endsWith('.db') && isSqlite(full)) out.push(path.relative(dataDir, full));
    }
  };
  walk(path.join(dataDir, 'data'), 0);
  if (isSqlite(path.join(dataDir, 'memory.db'))) out.push('memory.db');
  return out;
}

function isSqlite(file: string): boolean {
  let fd: number | undefined;
  try {
    if (fs.statSync(file).size === 0) return true; // a new, empty database
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(16);
    return fs.readSync(fd, head, 0, 16, 0) === 16 && head.toString('latin1') === 'SQLite format 3\0';
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Consistent copy of a live SQLite DB (folds in its WAL). */
async function copyDatabase(src: string, dest: string): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const db = new Database(src, { readonly: true, fileMustExist: true });
  try {
    await db.backup(dest);
  } finally {
    db.close();
  }
}

/**
 * Copy a tree for import. SQLite files go through the backup API (their
 * -wal/-shm are skipped). Links are followed at the top and for group
 * folders, so the copy never writes through into the source; deeper links
 * are kept, pointing at the same absolute place.
 */
async function copyTree(src: string, dest: string, follow: boolean, followChildren: boolean): Promise<void> {
  let st: fs.Stats;
  try {
    st = follow ? fs.statSync(src) : fs.lstatSync(src);
  } catch {
    st = fs.lstatSync(src); // a dangling link
  }
  if (st.isSymbolicLink()) {
    fs.symlinkSync(path.resolve(path.dirname(src), fs.readlinkSync(src)), dest);
    return;
  }
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const e of fs.readdirSync(src)) {
      if (/\.db-(wal|shm)$/.test(e)) continue;
      await copyTree(path.join(src, e), path.join(dest, e), followChildren, false);
    }
    return;
  }
  if (!st.isFile()) return; // sockets (data/cli.sock), FIFOs and devices aren't data
  if (src.endsWith('.db') && isSqlite(src)) await copyDatabase(src, dest);
  else fs.copyFileSync(src, dest);
}

/** Group files the new runtime renames or rewrites on first start. */
const GROUP_FILES = [
  'CLAUDE.md',
  'CLAUDE.local.md',
  'AGENTS.md',
  'AGENTS.local.md',
  '_composed.md',
  'container.json',
  '.claude-fragments',
];

function groupNames(dataDir: string): string[] {
  try {
    return fs
      .readdirSync(path.join(dataDir, 'groups'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

const LEGACY_IMAGE = /^clawbridge(?:-codex|-agent)?-v2-[0-9a-f]+:(.+)$/;

function stamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

/** Steps the upgrade will take, for the confirmation screen and --dry-run. */
export function planLegacyUpgrade(install: LegacyInstall, opts: UpgradeOptions): string[] {
  const tilde = tildeFor(opts);
  const steps: string[] = [];
  for (const s of install.services)
    steps.push(`Stop the old ${s.manager} service ${s.label} and keep its file in the backup`);
  for (const p of install.processes) steps.push(`Stop the old ClawBridge process (pid ${p.pid})`);
  if (install.inPlace) {
    steps.push(
      `Back up .env, ${listDatabases(install.dataDir).length} database file(s) and each agent's instruction files to ~/.clawbridge/upgrade-backup/`,
    );
  } else {
    steps.push(
      `Copy .env, data/, groups/ and store/ from ${tilde(install.dataDir)} into ~/.clawbridge (the original stays as it is)`,
    );
  }
  steps.push(
    `Add DEFAULT_AGENT_PROVIDER=${install.previousProvider} (your agents keep running on ${install.previousProvider === 'codex' ? 'Codex' : 'Claude'}), ENABLED_AGENT_PROVIDERS and CREDENTIAL_PROXY to .env; keep every other setting`,
  );
  const targets = linkTargets(opts.packageRoot);
  const toFix = (install.inPlace ? install.links : inspectLinks(aiHome(opts))).filter(
    (l) => l.status !== 'ok' && l.status !== 'not-a-link',
  );
  if (toFix.length)
    steps.push(`Point ${toFix.map((l) => l.name).join(', ')} at ${tilde(path.dirname(targets.container))}`);
  steps.push(`Mark ~/.clawbridge as a ClawBridge AI install (${AI_MARKER_FILE})`);
  return steps;
}

export async function upgradeLegacyInstall(install: LegacyInstall, opts: UpgradeOptions): Promise<UpgradeReport> {
  const home = homeOf(opts);
  const dest = aiHome(opts);
  const tilde = tildeFor(opts);
  const now = (opts.now ?? (() => new Date()))();
  const run = opts.run ?? defaultRun;
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const stopProcess = opts.stopProcess ?? ((pid: number) => defaultStopProcess(pid, isAlive));
  const report: UpgradeReport = { dataDir: dest, backupDir: null, steps: [], next: [] };

  if (opts.dryRun) {
    report.steps = planLegacyUpgrade(install, opts);
    return report;
  }

  // Preflight: nothing is touched until these pass.
  const unfinished = unfinishedLegacyBackup(opts);
  if (unfinished) {
    throw new LegacyUpgradeError(
      `An earlier upgrade stopped partway (backup ${tilde(unfinished)}). Undo it first with: clawbridge-ai migrate --rollback`,
      null,
    );
  }
  if (!install.inPlace && fs.existsSync(path.join(dest, 'data', 'v2.db'))) {
    const existing = inspectLegacyDir(dest, opts);
    throw new LegacyUpgradeError(
      existing
        ? `~/.clawbridge already holds an old install (${describeInstall(existing, home)}). Upgrade that one, or move it aside first.`
        : '~/.clawbridge already holds a ClawBridge AI install. Move it aside before importing another one.',
      null,
    );
  }
  const isRoot = opts.isRoot ?? process.getuid?.() === 0;
  if (isRoot && install.services.some((s) => s.manager === 'launchd')) {
    throw new LegacyUpgradeError('On macOS, run this without sudo: the service belongs to your user.', null);
  }
  const system = install.services.filter((s) => s.scope === 'system');
  if (system.length && !isRoot) {
    throw new LegacyUpgradeError(
      `The old service ${system.map((s) => s.label).join(', ')} is a system service. Run this again with sudo.`,
      null,
    );
  }

  fs.mkdirSync(backupRoot(opts), { recursive: true });
  const backupDir = fs.mkdtempSync(path.join(backupRoot(opts), `legacy-${stamp(now)}-`));
  report.backupDir = backupDir;
  const manifest: BackupManifest = {
    kind: install.kind,
    version: install.version,
    sourceDir: install.dataDir,
    inPlace: install.inPlace,
    createdAt: now.toISOString(),
    completed: false,
    envBackedUp: false,
    envCreated: false,
    databases: [],
    groupFiles: [],
    groupFilesAbsent: [],
    links: [],
    services: [],
    processes: [],
    created: [],
    moved: [],
    retaggedGroups: [],
  };
  const save = () => fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  save();

  try {
    // 1. Stop the old install first, so the databases are quiet when copied.
    //    Each service file is backed up before it is touched, and only
    //    removed once the service is confirmed stopped.
    for (const s of install.services) {
      const backupFile = path.join(backupDir, 'services', path.basename(s.file));
      fs.mkdirSync(path.dirname(backupFile), { recursive: true });
      fs.copyFileSync(s.file, backupFile);
      manifest.services.push({ ...s, backupFile });
      save();
      stopService(s, run);
      fs.unlinkSync(s.file);
      report.steps.push(`Stopped the old service ${s.label}`);
    }
    for (const scope of ['user', 'system'] as const) {
      if (install.services.some((s) => s.manager === 'systemd' && s.scope === scope)) {
        run('systemctl', [...(scope === 'user' ? ['--user'] : []), 'daemon-reload']);
      }
    }
    for (const p of install.processes) {
      if (!stopProcess(p.pid))
        throw new Error(`Couldn't stop the old ClawBridge process (pid ${p.pid}). Stop it, then run this again.`);
      manifest.processes.push(p); // recorded once stopped, so rollback restarts only what we stopped
      save();
      report.steps.push(`Stopped the old ClawBridge process (pid ${p.pid})`);
    }

    // 2. Back up in place, or copy the data into ~/.clawbridge.
    const envPath = path.join(dest, '.env');
    if (install.inPlace) {
      if (fs.existsSync(envPath)) {
        fs.copyFileSync(envPath, path.join(backupDir, '.env'));
        manifest.envBackedUp = true;
      }
      for (const rel of listDatabases(dest)) {
        await copyDatabase(path.join(dest, rel), path.join(backupDir, 'db', rel));
        manifest.databases.push(rel);
      }
      for (const g of groupNames(dest)) {
        for (const name of GROUP_FILES) {
          const rel = path.join('groups', g, name);
          if (fs.existsSync(path.join(dest, rel))) {
            fs.cpSync(path.join(dest, rel), path.join(backupDir, 'files', rel), {
              recursive: true,
              verbatimSymlinks: true,
            });
            manifest.groupFiles.push(rel);
          } else {
            manifest.groupFilesAbsent.push(rel);
          }
        }
      }
      save();
      report.steps.push(
        `Backed up .env, ${manifest.databases.length} database file(s) and ${groupNames(dest).length} agent group(s)' instructions`,
      );
    } else {
      fs.mkdirSync(dest, { recursive: true });
      for (const entry of ['.env', 'data', 'groups', 'store', 'memory.db']) {
        const src = path.join(install.dataDir, entry);
        if (!fs.existsSync(src)) continue;
        const to = path.join(dest, entry);
        // Record before acting, so a failure partway is still undone.
        manifest.created.push(entry);
        if (fs.existsSync(to) || isLink(to)) {
          manifest.moved.push(entry);
          save();
          fs.renameSync(to, path.join(backupDir, entry));
        }
        save();
        await copyTree(src, to, true, entry === 'groups');
      }
      fs.mkdirSync(path.join(dest, 'logs'), { recursive: true });
      report.steps.push(`Copied ${manifest.created.join(', ')} from ${tilde(install.dataDir)}`);
    }

    // 3. .env
    if (!fs.existsSync(envPath)) {
      manifest.envCreated = true;
      save();
    }
    const upgraded = upgradeLegacyEnv(readText(envPath) ?? '', {
      kind: install.kind,
      version: install.version,
      previousProvider: install.previousProvider,
      codexAuth: fs.existsSync(path.join(home, '.codex', 'auth.json')),
      date: now,
    });
    if (isLink(envPath)) {
      // Never write through a link. In place, remember it so rollback can put the link back.
      if (install.inPlace) {
        manifest.envLink = fs.readlinkSync(envPath);
        save();
      }
      fs.unlinkSync(envPath);
    }
    fs.writeFileSync(envPath, upgraded, { mode: 0o600 });
    fs.chmodSync(envPath, 0o600);
    report.steps.push(
      `Updated .env (agents stay on ${install.previousProvider === 'codex' ? 'Codex' : 'Claude'} by default)`,
    );

    // 4. Agent groups with their own image (extra packages) were built FROM the
    //    old base. Point them at the new base; the runtime rebuilds a missing
    //    per-group image on first use.
    const newBase = getContainerImageBase(opts.packageRoot);
    for (const g of groupNames(dest)) {
      const file = path.join(dest, 'groups', g, 'container.json');
      const text = readText(file);
      if (!text) continue;
      try {
        const cfg = JSON.parse(text) as { imageTag?: string };
        const m = cfg.imageTag?.match(LEGACY_IMAGE);
        if (!m) continue;
        cfg.imageTag = `${newBase}:${m[1]}`;
        fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
        manifest.retaggedGroups.push(g);
        save();
      } catch {
        /* not JSON; leave it */
      }
    }

    // 5. Runtime links.
    const targets = linkTargets(opts.packageRoot);
    for (const link of inspectLinks(dest)) {
      if (link.status === 'ok' || link.status === 'not-a-link') continue;
      const target = targets[link.name];
      if (!target || !fs.existsSync(target)) continue;
      const full = path.join(dest, link.name);
      manifest.links.push({ name: link.name, target: link.target, wasLink: link.status !== 'missing' });
      save();
      if (link.status !== 'missing') fs.unlinkSync(full);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.symlinkSync(target, full);
    }
    if (manifest.links.length) report.steps.push(`Repointed ${manifest.links.map((l) => l.name).join(', ')}`);

    // 6. Marker, then mark the backup complete.
    fs.writeFileSync(
      path.join(dest, AI_MARKER_FILE),
      JSON.stringify(
        {
          migratedFrom: install.kind,
          fromVersion: install.version ?? null,
          source: install.dataDir,
          migratedAt: now.toISOString(),
          backup: backupDir,
        },
        null,
        2,
      ) + '\n',
    );
    manifest.completed = true;
    save();
  } catch (err) {
    throw new LegacyUpgradeError(err instanceof Error ? err.message : String(err), backupDir);
  }

  // What's left for the owner.
  const images = [...new Set(install.services.map((s) => s.image).filter((i): i is string => Boolean(i)))];
  report.next.push('Build the new agent image: clawbridge-ai build-image');
  report.next.push('Start the new service: clawbridge-ai service install');
  if (manifest.retaggedGroups.length) {
    report.next.push(
      `${manifest.retaggedGroups.join(', ')} had extra packages; their image is rebuilt on the new base the first time each one runs`,
    );
  }
  if (!install.inPlace) {
    report.next.push(`Your old folder ${tilde(install.dataDir)} was not changed; delete it once you're happy`);
  } else if (install.packageName) {
    report.next.push(`Remove the old package when you're happy: npm uninstall -g ${install.packageName}`);
  }
  if (runtimeVersion(dest))
    report.next.push('The old runtime copy in ~/.clawbridge/runtime/ is no longer used and can be deleted');
  if (images.length) report.next.push(`Free the old image's disk space: docker image rm ${images.join(' ')}`);
  report.next.push(
    'Memories saved before memory became per-conversation (Hindsight bank client-global) are kept but no longer recalled. Re-add anything the whole team should know with /teamfact.',
  );
  report.next.push('Undo all of this with: clawbridge-ai migrate --rollback');
  return report;
}

function isLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// ─── Verify ──────────────────────────────────────────────────────────────────

export interface LegacyCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export function verifyLegacyUpgrade(opts: UpgradeOptions, install?: LegacyInstall): LegacyCheck[] {
  const dest = aiHome(opts);
  const checks: LegacyCheck[] = [];
  const env = parseEnv(readText(path.join(dest, '.env')) ?? '');
  checks.push({
    name: 'Providers',
    ok: env.has('DEFAULT_AGENT_PROVIDER') && env.has('ENABLED_AGENT_PROVIDERS'),
    detail: `default ${env.get('DEFAULT_AGENT_PROVIDER') ?? 'missing'}, enabled ${env.get('ENABLED_AGENT_PROVIDERS') ?? 'missing'}`,
  });
  const dbPath = path.join(dest, 'data', 'v2.db');
  if (fs.existsSync(dbPath)) {
    try {
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      const integrity = (db.pragma('quick_check', { simple: true }) as string) ?? '';
      const groups = (db.prepare('SELECT COUNT(*) AS n FROM agent_groups').get() as { n: number }).n;
      db.close();
      checks.push({ name: 'Database', ok: integrity === 'ok', detail: `${integrity}, ${groups} agent group(s)` });
    } catch (err) {
      checks.push({ name: 'Database', ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  }
  const bad = inspectLinks(dest).filter((l) => l.status !== 'ok');
  checks.push({
    name: 'Runtime links',
    ok: bad.length === 0,
    detail: bad.length
      ? bad.map((l) => `${l.name}: ${l.status}`).join(', ')
      : 'container, src/shared, docker-compose.yml',
  });
  const dirs = [...new Set([dest, ...(install ? [install.dataDir] : [])])];
  const leftover = dirs.flatMap((d) => findLegacyServices(d, opts).map((s) => s.label));
  const alive = (install?.processes ?? [])
    .filter((p) => (opts.isAlive ?? defaultIsAlive)(p.pid))
    .map((p) => `pid ${p.pid}`);
  checks.push({
    name: 'Old service',
    ok: leftover.length + alive.length === 0,
    detail:
      leftover.length + alive.length ? `still there: ${[...leftover, ...alive].join(', ')}` : 'stopped and removed',
  });
  checks.push({ name: 'Marker', ok: fs.existsSync(path.join(dest, AI_MARKER_FILE)), detail: AI_MARKER_FILE });
  return checks;
}

// ─── Rollback ────────────────────────────────────────────────────────────────

/**
 * Put an upgraded install back the way it was and start its old service.
 *
 * ClawBridge AI's own services are found and stopped first (confirmed, or
 * nothing is touched). The current state is moved or copied into the backup
 * (before-rollback-*) rather than deleted, so a rollback loses nothing.
 */
export async function rollbackLegacyUpgrade(
  opts: LegacyContext & {
    backupDir?: string;
    run?: Run;
    now?: () => Date;
    /** The clawbridge-ai package root, where a nohup-started instance keeps its pid file. */
    packageRoot?: string;
    stopProcess?: (pid: number) => boolean;
  } = {},
): Promise<string[]> {
  const dest = aiHome(opts);
  const run = opts.run ?? defaultRun;
  const backupDir = opts.backupDir ?? latestLegacyBackup(opts);
  if (!backupDir) throw new Error('No upgrade backup found in ~/.clawbridge/upgrade-backup/.');
  const manifest = readManifest(backupDir);
  if (!manifest) throw new Error(`${backupDir} has no manifest.json.`);
  const steps: string[] = [];
  const now = (opts.now ?? (() => new Date()))();

  // 1. Stop ClawBridge AI so nothing has the databases open.
  const isRoot = opts.isRoot ?? process.getuid?.() === 0;
  if (isRoot && (opts.platform ?? process.platform) === 'darwin') {
    throw new Error('On macOS, run the rollback without sudo: the services belong to your user.');
  }
  const snap = path.join(backupDir, `before-rollback-${stamp(now)}`);
  // A ClawBridge AI started by the nohup fallback has no service file; find it
  // by its pid file. Stopped first, so a refusal here leaves everything as it was.
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const stopProcess = opts.stopProcess ?? ((pid: number) => defaultStopProcess(pid, isAlive));
  const aiRoots = [opts.packageRoot, aiPackageRootFromLinks(dest)].filter((r): r is string => Boolean(r));
  for (const proc of findPidFileProcesses(aiRoots, opts)) {
    if (!stopProcess(proc.pid)) {
      throw new Error(`Couldn't stop ClawBridge AI (pid ${proc.pid}). Stop it, then run the rollback again.`);
    }
    steps.push(`Stopped ClawBridge AI (pid ${proc.pid})`);
  }
  const aiServices = findAiServices(dest, opts);
  for (const s of aiServices) {
    stopService(s, run);
    const keep = path.join(snap, 'services', path.basename(s.file));
    fs.mkdirSync(path.dirname(keep), { recursive: true });
    fs.copyFileSync(s.file, keep);
    fs.unlinkSync(s.file);
    steps.push(`Stopped ClawBridge AI (${s.label})`);
  }
  for (const scope of ['user', 'system'] as const) {
    if (aiServices.some((s) => s.manager === 'systemd' && s.scope === scope)) {
      run('systemctl', [...(scope === 'user' ? ['--user'] : []), 'daemon-reload']);
    }
  }
  fs.mkdirSync(snap, { recursive: true });

  // 2. Keep the current state, then restore.
  if (manifest.inPlace) {
    const envPath = path.join(dest, '.env');
    if (fs.existsSync(envPath)) fs.copyFileSync(envPath, path.join(snap, '.env'));
    for (const rel of listDatabases(dest)) await copyDatabase(path.join(dest, rel), path.join(snap, 'db', rel));
    for (const rel of [...manifest.groupFiles, ...manifest.groupFilesAbsent]) {
      if (fs.existsSync(path.join(dest, rel))) {
        fs.cpSync(path.join(dest, rel), path.join(snap, 'files', rel), { recursive: true, verbatimSymlinks: true });
      }
    }

    if (manifest.envLink) {
      fs.rmSync(envPath, { force: true });
      fs.symlinkSync(manifest.envLink, envPath);
    } else if (manifest.envBackedUp) {
      fs.copyFileSync(path.join(backupDir, '.env'), envPath);
    } else if (manifest.envCreated) {
      fs.rmSync(envPath, { force: true });
    }
    for (const rel of manifest.databases) {
      const target = path.join(dest, rel);
      // The new runtime may have removed the folder (finished tasks, deleted groups).
      fs.mkdirSync(path.dirname(target), { recursive: true });
      for (const side of ['-wal', '-shm']) fs.rmSync(target + side, { force: true });
      fs.copyFileSync(path.join(backupDir, 'db', rel), target);
    }
    for (const rel of manifest.groupFilesAbsent) fs.rmSync(path.join(dest, rel), { recursive: true, force: true });
    for (const rel of manifest.groupFiles) {
      fs.rmSync(path.join(dest, rel), { recursive: true, force: true });
      fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
      fs.cpSync(path.join(backupDir, 'files', rel), path.join(dest, rel), { recursive: true, verbatimSymlinks: true });
    }
    steps.push(`Restored .env, ${manifest.databases.length} database file(s) and the agents' instruction files`);
  } else {
    for (const entry of manifest.created) {
      const here = path.join(dest, entry);
      if (fs.existsSync(here) || isLink(here)) fs.renameSync(here, path.join(snap, entry));
    }
    for (const entry of manifest.moved) {
      const kept = path.join(backupDir, entry);
      if (fs.existsSync(kept) || isLink(kept)) fs.renameSync(kept, path.join(dest, entry));
    }
    if (manifest.envCreated && !manifest.created.includes('.env')) {
      const envPath = path.join(dest, '.env');
      if (fs.existsSync(envPath)) fs.renameSync(envPath, path.join(snap, '.env'));
    }
    steps.push(`Moved the imported copy out of ~/.clawbridge (${manifest.sourceDir} was never changed)`);
  }
  if (fs.existsSync(path.join(dest, AI_MARKER_FILE)))
    fs.renameSync(path.join(dest, AI_MARKER_FILE), path.join(snap, AI_MARKER_FILE));

  for (const link of manifest.links) {
    const full = path.join(dest, link.name);
    fs.rmSync(full, { force: true });
    if (link.wasLink && link.target) fs.symlinkSync(link.target, full);
  }
  if (manifest.links.length) steps.push(`Restored ${manifest.links.map((l) => l.name).join(', ')}`);

  // 3. Start the old install again.
  for (const s of manifest.services) {
    fs.mkdirSync(path.dirname(s.file), { recursive: true });
    fs.copyFileSync(s.backupFile, s.file);
    startService(s, run);
    steps.push(`Started the old service ${s.label}`);
  }
  for (const p of manifest.processes) {
    // Same rule as detection: alive AND running code from that install, so a reused pid doesn't count.
    const running = findPidFileProcesses([path.dirname(p.pidFile)], opts)[0];
    if (running) {
      steps.push(`The old ClawBridge process is already running (pid ${running.pid})`);
    } else if (p.wrapper && fs.existsSync(p.wrapper)) {
      run('bash', [p.wrapper]);
      steps.push(`Started the old ClawBridge process (${p.wrapper})`);
    } else {
      steps.push('Start the old ClawBridge process the way you used to');
    }
  }

  const done = path.join(path.dirname(backupDir), path.basename(backupDir).replace(/^legacy-/, 'rolled-back-'));
  fs.renameSync(backupDir, done);
  steps.push(
    `${LEGACY_LABEL[manifest.kind]} is back as it was. What ClawBridge AI had is kept in ${tildeFor(opts)(path.join(done, path.basename(snap)))}`,
  );
  return steps;
}

/** Set one key in .env text, replacing its line or appending it. */
export function setEnvValue(text: string, key: string, value: string): string {
  const line = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
  if (line.test(text)) return text.replace(line, `${key}=${value}`);
  return text.replace(/\s*$/, '') + `\n${key}=${value}\n`;
}

/**
 * Mark ~/.clawbridge as a ClawBridge AI install and create any runtime link
 * that is missing or broken. Links that already point somewhere valid are
 * left alone. Refuses when ~/.clawbridge still holds an old install, which
 * must go through the upgrade instead. Returns the links it created.
 */
export function markAiInstall(opts: LegacyContext & { packageRoot: string; now?: Date }): string[] {
  const dest = aiHome(opts);
  const legacy = inspectLegacyDir(dest, opts);
  // Leftover links or a runtime/ copy next to a .env this setup just wrote (and
  // no old data) aren't an install to upgrade; the links are repointed below.
  const freshEnv = parseEnv(readText(path.join(dest, '.env')) ?? '').has('ENABLED_AGENT_PROVIDERS');
  const oldData = fs.existsSync(path.join(dest, 'data', 'v2.db'));
  if (legacy && !(freshEnv && !oldData)) {
    throw new Error(
      `~/.clawbridge holds ${describeInstall(legacy, homeOf(opts))}. Upgrade it with: clawbridge-ai migrate`,
    );
  }
  fs.mkdirSync(dest, { recursive: true });
  const marker = path.join(dest, AI_MARKER_FILE);
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, JSON.stringify({ installedAt: (opts.now ?? new Date()).toISOString() }, null, 2) + '\n');
  }
  const targets = linkTargets(opts.packageRoot);
  const made: string[] = [];
  for (const link of inspectLinks(dest)) {
    if (link.status === 'ok' || link.status === 'not-a-link') continue;
    const target = targets[link.name];
    if (!target || !fs.existsSync(target)) continue;
    const full = path.join(dest, link.name);
    if (link.status !== 'missing') fs.unlinkSync(full);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.symlinkSync(target, full);
    made.push(link.name);
  }
  return made;
}

/** Restart a running service so it rereads .env. */
export function restartService(s: LegacyService, run: Run = defaultRun): void {
  if (s.manager === 'launchd') run('launchctl', ['kickstart', '-k', `gui/${uid()}/${s.label}`]);
  else run('systemctl', [...scopeArgs(s), 'restart', `${s.label}.service`]);
}
