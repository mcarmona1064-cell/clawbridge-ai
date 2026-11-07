/**
 * Skills library: install extra skills, pinned to an exact commit.
 *
 *   /skills                                   list built-in and installed skills
 *   /skills install <owner/repo>@<sha>[:dir]  admin: review, then approve to install
 *   /skills update <name> <sha>               admin: same, showing what changed
 *   /skills remove <name>                     admin
 *
 * Only a full 40-character commit SHA is accepted (no branches or tags,
 * which can move). Before anything is installed, the host checks out that
 * exact commit, scans it for install-time lures (curl | sh, encoded
 * payloads, instructions to ignore rules or skip approvals) and sends an
 * approval card with the file list and any warnings. Installed skills live
 * outside the code checkout (DATA_DIR/skills) and are mounted read-only.
 */
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { audit } from '../../audit.js';
import { registerDeliveryAction } from '../../delivery.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { registerApprovalHandler, requestApproval } from '../approvals/index.js';
import { hasAdminPrivilege } from '../permissions/db/user-roles.js';
import { installedSkillsDir } from './paths.js';

export { installedSkillsDir };

export interface SkillSource {
  repo: string;
  sha: string;
  dir: string;
  installedBy: string | null;
  installedAt: string;
  digest: string;
}

/** "owner/repo@<sha>[:dir]" or "https://github.com/owner/repo@<sha>[:dir]". */
export function parseSkillRef(ref: string): { repo: string; sha: string; dir: string } | null {
  const m = /^(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?@([0-9a-f]{40})(?::([\w./-]+))?$/i.exec(
    ref.trim(),
  );
  if (!m || (m[3] && /(^|\/)\.\.(\/|$)/.test(m[3]))) return null;
  return { repo: m[1], sha: m[2].toLowerCase(), dir: (m[3] ?? '').replace(/^\/|\/$/g, '') };
}

const LURES: Array<{ re: RegExp; why: string }> = [
  { re: /\b(curl|wget)\b[^\n|]*\|\s*(ba|z)?sh\b/i, why: 'pipes a download straight into a shell' },
  { re: /base64\s+(-d|--decode)[^\n]*\|\s*(ba|z)?sh/i, why: 'decodes and runs hidden code' },
  { re: /\beval\s*\(\s*(atob|Buffer\.from)/i, why: 'evaluates encoded code' },
  { re: /ignore (all )?(previous|prior) (instructions|rules)/i, why: 'tells the agent to ignore its instructions' },
  {
    re: /(skip|bypass|disable)\s+(the\s+)?(approval|permission|confirmation)s?/i,
    why: 'tells the agent to skip approvals',
  },
  {
    re: /\.clawbridge\/\.env|\.ssh\/id_|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|auth\.json/i,
    why: 'reaches for credentials',
  },
  { re: /\b(rm\s+-rf\s+[~/]|mkfs|:\(\)\s*\{\s*:\|:&\s*\};:)/, why: 'contains destructive commands' },
];

export interface ScanResult {
  files: Array<{ path: string; bytes: number; sha256: string }>;
  warnings: Array<{ file: string; why: string }>;
  hasSkillMd: boolean;
}

export function scanSkill(dir: string): ScanResult {
  const files: ScanResult['files'] = [];
  const warnings: ScanResult['warnings'] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git' || (d === dir && e.name === '.source.json')) continue;
      const full = path.join(d, e.name);
      const rel = path.relative(dir, full);
      if (e.isSymbolicLink()) {
        warnings.push({ file: rel, why: 'is a symbolic link (not installed)' });
        continue;
      }
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      const buf = fs.readFileSync(full);
      files.push({ path: rel, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
      if (buf.length < 512 * 1024) {
        const text = buf.toString('utf8');
        for (const l of LURES) if (l.re.test(text)) warnings.push({ file: rel, why: l.why });
      }
    }
  };
  walk(dir);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, warnings, hasSkillMd: files.some((f) => f.path === 'SKILL.md') };
}

export function digestOf(scan: ScanResult): string {
  return crypto
    .createHash('sha256')
    .update(scan.files.map((f) => `${f.path}:${f.sha256}`).join('\n'))
    .digest('hex');
}

export function diffScans(
  oldScan: ScanResult,
  newScan: ScanResult,
): { added: string[]; removed: string[]; changed: string[] } {
  const o = new Map(oldScan.files.map((f) => [f.path, f.sha256]));
  const n = new Map(newScan.files.map((f) => [f.path, f.sha256]));
  return {
    added: [...n.keys()].filter((p) => !o.has(p)),
    removed: [...o.keys()].filter((p) => !n.has(p)),
    changed: [...n.keys()].filter((p) => o.has(p) && o.get(p) !== n.get(p)),
  };
}

export type GitCheckout = (repo: string, sha: string, into: string) => void;

/** Shallow fetch of exactly one commit. */
export const defaultCheckout: GitCheckout = (repo, sha, into) => {
  const url = /^(https?:|file:|\/)/.test(repo) ? repo : `https://github.com/${repo}.git`;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: into, stdio: 'pipe', timeout: 120_000 });
  fs.mkdirSync(into, { recursive: true });
  git('init', '-q');
  git('remote', 'add', 'origin', url);
  git('fetch', '-q', '--depth', '1', 'origin', sha);
  git('checkout', '-q', 'FETCH_HEAD');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: into }).toString().trim();
  if (head !== sha) throw new Error(`checked out ${head}, expected ${sha}`);
};

function skillName(dir: string, repo: string): string {
  return (dir ? path.basename(dir) : repo.split('/')[1])
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 40);
}

export function listInstalled(): Array<{ name: string; source: SkillSource }> {
  const root = installedSkillsDir();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .map((name) => {
      try {
        return {
          name,
          source: JSON.parse(fs.readFileSync(path.join(root, name, '.source.json'), 'utf8')) as SkillSource,
        };
      } catch {
        return null;
      }
    })
    .filter((x): x is { name: string; source: SkillSource } => x !== null);
}

/** Stage a checkout for review. Returns the card text, or an error. */
export function stageSkill(
  ref: { repo: string; sha: string; dir: string },
  checkout: GitCheckout = defaultCheckout,
): { stagingDir: string; name: string; scan: ScanResult } | { error: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-skill-'));
  try {
    checkout(ref.repo, ref.sha, tmp);
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return { error: `Could not fetch ${ref.repo} at ${ref.sha.slice(0, 7)}: ${(err as Error).message.split('\n')[0]}` };
  }
  const skillDir = path.join(tmp, ref.dir);
  if (!fs.existsSync(skillDir) || !fs.statSync(skillDir).isDirectory())
    return { error: `No folder "${ref.dir}" in that commit.` };
  const scan = scanSkill(skillDir);
  if (!scan.hasSkillMd) return { error: 'That folder has no SKILL.md, so it is not a skill.' };
  return { stagingDir: skillDir, name: skillName(ref.dir, ref.repo), scan };
}

export function installStaged(
  stagingDir: string,
  name: string,
  ref: { repo: string; sha: string; dir: string },
  by: string | null,
): void {
  const dest = path.join(installedSkillsDir(), name);
  const scan = scanSkill(stagingDir);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const f of scan.files) {
    fs.mkdirSync(path.dirname(path.join(dest, f.path)), { recursive: true });
    fs.copyFileSync(path.join(stagingDir, f.path), path.join(dest, f.path));
  }
  const source: SkillSource = {
    ...ref,
    installedBy: by,
    installedAt: new Date().toISOString(),
    digest: digestOf(scan),
  };
  fs.writeFileSync(path.join(dest, '.source.json'), JSON.stringify(source, null, 2));
  audit('skill.installed', {
    actor: by,
    target: name,
    detail: { repo: ref.repo, sha: ref.sha, files: scan.files.length },
  });
}

export async function skillsCommand(opts: {
  session: Session;
  userId: string | null;
  args: string;
  checkout?: GitCheckout;
}): Promise<string> {
  const [sub, a, b] = opts.args.trim().split(/\s+/).filter(Boolean);
  if (!sub) {
    const builtIn = fs.existsSync(path.join(process.cwd(), 'container', 'skills'))
      ? fs.readdirSync(path.join(process.cwd(), 'container', 'skills'))
      : [];
    const installed = listInstalled();
    return [
      `**Built-in skills:** ${builtIn.join(', ') || 'none'}`,
      installed.length
        ? `**Installed:**\n${installed.map((i) => `• ${i.name} — ${i.source.repo} @ ${i.source.sha.slice(0, 7)}`).join('\n')}`
        : 'No extra skills installed.',
      'Admins: /skills install <owner/repo>@<full commit sha>[:folder]',
    ].join('\n');
  }
  if (!opts.userId || !hasAdminPrivilege(opts.userId, opts.session.agent_group_id))
    return 'Only an admin can manage skills.';

  if (sub === 'remove') {
    const target = path.join(installedSkillsDir(), (a ?? '').replace(/[^a-z0-9-]/g, ''));
    if (!a || !fs.existsSync(path.join(target, '.source.json'))) return `No installed skill "${a}".`;
    fs.rmSync(target, { recursive: true, force: true });
    audit('skill.removed', { actor: opts.userId, target: a });
    return `Removed ${a}. It is gone from new conversations.`;
  }

  let ref: { repo: string; sha: string; dir: string } | null = null;
  let previous: { name: string; source: SkillSource } | undefined;
  if (sub === 'install') ref = parseSkillRef(a ?? '');
  else if (sub === 'update') {
    previous = listInstalled().find((i) => i.name === a);
    if (!previous) return `No installed skill "${a}".`;
    if (!/^[0-9a-f]{40}$/i.test(b ?? '')) return 'Usage: /skills update <name> <full 40-character commit sha>';
    ref = { repo: previous.source.repo, sha: b!.toLowerCase(), dir: previous.source.dir };
  } else return 'Use /skills, /skills install, /skills update or /skills remove.';
  if (!ref)
    return 'Use /skills install owner/repo@<full 40-character commit sha>[:folder]. Branches and tags are not accepted because they can change.';

  const staged = stageSkill(ref, opts.checkout);
  if ('error' in staged) return staged.error;
  let changes = '';
  if (previous) {
    const d = diffScans(scanSkill(path.join(installedSkillsDir(), previous.name)), staged.scan);
    changes = `\nChanges since ${previous.source.sha.slice(0, 7)}: ${d.added.length} added, ${d.changed.length} changed, ${d.removed.length} removed${
      d.changed.length ? ` (${d.changed.slice(0, 8).join(', ')})` : ''
    }`;
  }
  const warnings = staged.scan.warnings.length
    ? `\n⚠️ Warnings:\n${staged.scan.warnings.map((w) => `• ${w.file} ${w.why}`).join('\n')}`
    : '\nNo warnings from the safety scan.';
  const ok = await requestApproval({
    session: opts.session,
    agentName: opts.session.agent_group_id,
    action: 'skill_install',
    payload: { stagingDir: staged.stagingDir, name: staged.name, ref, digest: digestOf(staged.scan) },
    title: `Install skill "${staged.name}"?`,
    question: `${ref.repo} @ ${ref.sha.slice(0, 7)}${ref.dir ? `, folder ${ref.dir}` : ''} — ${staged.scan.files.length} files.${changes}${warnings}\n\nSkills become part of the agent's instructions. Install only skills you trust.`,
    risk: staged.scan.warnings.length ? 'high' : 'medium',
  });
  return ok
    ? 'I sent an approval card with the safety scan. The skill is installed once it is approved.'
    : 'No admin could be reached to approve.';
}

registerApprovalHandler('skill_install', async ({ payload, userId, notify }) => {
  const p = payload as {
    stagingDir: string;
    name: string;
    ref: { repo: string; sha: string; dir: string };
    digest: string;
  };
  if (!fs.existsSync(p.stagingDir)) throw new Error('the reviewed checkout is gone; run /skills install again');
  // Install exactly what was reviewed: refuse if the staged files changed since the card was sent.
  if (digestOf(scanSkill(p.stagingDir)) !== p.digest)
    throw new Error('the staged files changed after review; not installed');
  installStaged(p.stagingDir, p.name, p.ref, userId);
  log.info('Skill installed', { name: p.name, repo: p.ref.repo, sha: p.ref.sha });
  notify(`Skill "${p.name}" installed. It is available in new conversations.`);
});

// ── Record-to-skill: the agent proposes a procedure it worked out ──

/** Validate a proposed local skill. */
export function validateProposedSkill(
  name: unknown,
  steps: unknown,
): { name: string; steps: string } | { error: string } {
  const n = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  const s = String(steps ?? '').trim();
  if (!n) return { error: 'name is required' };
  if (s.length < 20) return { error: 'describe the steps (at least a few lines)' };
  if (s.length > 20_000) return { error: 'keep a skill under 20,000 characters' };
  return { name: n, steps: s };
}

export async function handleProposeSkill(content: Record<string, unknown>, session: Session): Promise<void> {
  const checked = validateProposedSkill(content.name, content.steps);
  const { notifyAgent } = await import('../approvals/index.js');
  if ('error' in checked) {
    notifyAgent(session, `propose_skill failed: ${checked.error}.`);
    return;
  }
  if (fs.existsSync(path.join(installedSkillsDir(), checked.name))) {
    notifyAgent(session, `propose_skill failed: a skill named "${checked.name}" already exists.`);
    return;
  }
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-skill-local-'));
  const description = String(content.description ?? '').slice(0, 200);
  fs.writeFileSync(
    path.join(staging, 'SKILL.md'),
    `---\nname: ${checked.name}\ndescription: ${description || checked.name}\n---\n\n${checked.steps}\n`,
  );
  fs.writeFileSync(
    path.join(staging, 'instructions.md'),
    `Saved procedure **${checked.name}**${description ? ` (${description})` : ''}: when this task comes up, follow /app/skills-installed/${checked.name}/SKILL.md.`,
  );
  const scan = scanSkill(staging);
  const warnings = scan.warnings.length
    ? `\n⚠️ Warnings:\n${scan.warnings.map((w) => `• ${w.file} ${w.why}`).join('\n')}`
    : '';
  await requestApproval({
    session,
    agentName: session.agent_group_id,
    action: 'skill_install',
    payload: {
      stagingDir: staging,
      name: checked.name,
      ref: { repo: 'local', sha: 'recorded', dir: '' },
      digest: digestOf(scan),
    },
    title: `Save "${checked.name}" as a skill?`,
    question: `The agent wants to remember this procedure for next time:\n\n${checked.steps.slice(0, 1200)}${checked.steps.length > 1200 ? '\n…' : ''}${warnings}`,
    risk: scan.warnings.length ? 'high' : 'low',
  });
}

registerDeliveryAction('propose_skill', handleProposeSkill);
