import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(process.cwd());

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

describe('Dual-provider (Claude + Codex) regression checks', () => {
  it('routes host-side LLM calls through provider CLIs, never raw API calls', () => {
    const hostLlmCallers = [
      'src/error-handler.ts',
      'src/memory/extractor.ts',
      'src/memory/reflection-agent.ts',
      'src/memory/cross-client.ts',
    ];

    for (const rel of hostLlmCallers) {
      const content = read(rel);
      expect(content, rel).toContain('runHostPrompt');
      expect(content, rel).not.toMatch(
        /OPENAI_API_KEY|ANTHROPIC_API_KEY|api\.openai\.com|api\.anthropic\.com|Authorization:\s*`Bearer/,
      );
    }

    const hostLlm = read('src/host-llm.ts');
    expect(hostLlm).toContain('runCodexPrompt');
    expect(hostLlm).toContain('runClaudePrompt');

    const codexCli = read('src/codex-cli.ts');
    expect(codexCli).toMatch(/execFile\(\s*'codex'/);
    expect(codexCli).toContain("'--sandbox', sandbox");
    expect(codexCli).toContain("sandbox = 'read-only'");

    const claudeCli = read('src/claude-cli.ts');
    expect(claudeCli).toMatch(/execFile\(\s*'claude'/);
    expect(claudeCli).toContain("sandbox = 'read-only'");
  });

  it('setup offers Claude and Codex, and never creates OpenAI API-key runtime auth', () => {
    const auth = read('setup/auth.ts');

    expect(auth).toMatch(/\.codex['"],\s*['"]auth\.json/);
    expect(auth).toContain('codex login --device-auth');
    expect(auth).not.toMatch(/OPENAI_API_KEY/);
    expect(auth).not.toMatch(/OPENAI_OK/);
    expect(auth).not.toMatch(/hasApiKey/);
    expect(auth).not.toMatch(/writeEnvKey/);
    expect(auth).not.toMatch(/CREATED:\s*true/);

    // Setup offers both providers; doctor checks auth for each enabled one.
    const wizard = read('src/setup/index.ts');
    expect(wizard).toContain('setupProviders');
    expect(wizard).toContain('claude setup-token');
    expect(wizard).toContain('CLAUDE_SUBSCRIPTION_NOTE');
    expect(wizard).toContain('DEFAULT_AGENT_PROVIDER=');
    expect(read('src/doctor.ts')).toContain('Claude auth');
    expect(read('src/doctor.ts')).toContain('~/.codex/auth.json');
    expect(read('setup/register.ts')).toContain('AGENTS.local.md');
  });

  it('quick-start hands off to durable interactive setup, not setup:auto', () => {
    const quickStart = read('clawbridge.sh');
    expect(quickStart).not.toMatch(/pnpm\s+(?:--silent\s+)?run\s+setup:auto\b/);
    expect(quickStart).toMatch(/exec\s+pnpm\s+(?:--silent\s+)?run\s+setup:wizard\b/);
    expect(quickStart).toContain('$HOME/.local/share/clawbridge-ai/source');
  });

  it('configures Hindsight to use OpenAI Codex OAuth instead of OpenAI API keys', () => {
    const compose = read('integrations/docker-compose.yml');
    expect(compose).toContain('HINDSIGHT_API_LLM_PROVIDER: ${HINDSIGHT_LLM_PROVIDER:-openai-codex}');
    expect(compose).toContain('${HOME}/.codex:/home/hindsight/.codex:ro');
    expect(compose).not.toMatch(/HINDSIGHT_API_LLM_API_KEY:\s*\$\{HINDSIGHT_LLM_API_KEY:-\$\{OPENAI_API_KEY\}\}/);
    expect(compose).not.toContain('uses OpenAI by default');

    const setupWizard = read('src/setup/index.ts');
    expect(setupWizard).toContain("HINDSIGHT_LLM_PROVIDER: 'openai-codex'");
    expect(setupWizard).not.toContain("HINDSIGHT_LLM_PROVIDER: 'openai'");
    expect(setupWizard).not.toContain('separate API key for Hindsight LLM ops');

    const doctor = read('src/doctor.ts');
    expect(doctor).toContain("expectedLlmProvider = 'openai-codex'");
    expect(doctor).toContain('Codex auth');
  });

  it('keeps active Hindsight docs on OpenAI Codex OAuth and not stale Claude/OpenAI API-key auth', () => {
    const hindsightDocs = read('docs/hindsight.md');
    expect(hindsightDocs).toContain('openai-codex');
    expect(hindsightDocs).toContain('~/.codex/auth.json');
    expect(hindsightDocs).toContain('codex login --device-auth');
    expect(hindsightDocs).not.toMatch(/claude-code|CLAUDE_CODE_OAUTH_TOKEN|sk-ant|bare OpenAI API key/i);
  });

  it('keeps active command hints on clawbridge-ai names', () => {
    const activeHintFiles = [
      'src/doctor.ts',
      'src/container-runner.ts',
      'src/updater.ts',
      'src/setup/index.ts',
      'setup/index.ts',
      'setup/service.ts',
      'setup/verify.ts',
      'clawbridge.sh',
    ];

    const forbiddenHint =
      /(?:run:\s*|Run:\s*|retry:\s*|reinstall:\s*|npm install -g\s+)(?:npx\s+)?(?:clawbridge-agent(?:@latest)?|clawbridge\b(?!-ai))/;

    for (const rel of activeHintFiles) {
      const content = read(rel);
      expect(content, rel).not.toMatch(forbiddenHint);
    }
  });

  it('shows ClawBridge Claude migration in setup instead of NanoClaw', () => {
    const setupWizard = read('src/setup/index.ts');
    expect(setupWizard).toContain('Migrate from ClawBridge (Claude)');
    expect(setupWizard).not.toContain("label: 'Migrate from NanoClaw'");
    expect(setupWizard).toContain("value: 'clawbridge'");
  });

  it('mounts one composed instruction file as both AGENTS.md and CLAUDE.md', () => {
    expect(read('src/group-init.ts')).toContain('AGENTS.local.md');

    const runner = read('src/container-runner.ts');
    expect(runner).toContain("['AGENTS.md', 'CLAUDE.md']");
    expect(runner).toContain('/workspace/agent/${name}');
    expect(runner).toContain('CLAWBRIDGE_PROVIDER=');
    expect(runner).toContain('providerStateDir(agentGroup.id, provider)');
  });

  it('does not keep tracked backup files with stale Claude-era auth logic', () => {
    expect(fs.existsSync(path.join(ROOT, 'src/doctor.ts.bak'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'src/env.ts.bak'))).toBe(false);
  });

  it('confines Claude credentials to the Claude provider/auth files and never calls the Anthropic API directly', () => {
    const scannedRoots = ['src', 'setup', 'integrations', 'container/agent-runner/src'].map((rel) =>
      path.join(ROOT, rel),
    );
    const claudeAuthFiles = new Set(
      [
        'src/claude-cli.ts', // resolves the Claude credential for host-side `claude -p`
        'src/host-llm.ts', // login hint names the ANTHROPIC_API_KEY variable to set
        'container/agent-runner/src/scheduling/task-script.ts', // strips credential env vars from task scripts
        'src/providers/claude.ts', // passes the credential into claude containers
        'src/setup/index.ts', // setup wizard writes the token to ~/.clawbridge/.env
        'src/setup/migrate.ts', // migration detects legacy Claude env/files
        'src/doctor.ts', // reports Claude auth status
        'setup/verify.ts',
        'setup/probe.sh',
        'container/agent-runner/src/providers/claude.ts', // Claude Code env tuning (CLAUDE_CODE_*)
        'src/credential-proxy.ts', // swaps container placeholders for the real credential
        'src/friendly-errors.ts', // admin fix hint names the variable to update
      ].map((rel) => path.join(ROOT, rel)),
    );
    // The proxy forwards containers' own API calls upstream; nothing else may call the API.
    const forwardsToApi = new Set([path.join(ROOT, 'src/credential-proxy.ts')]);
    const credentialPattern = /ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|sk-ant|CLAUDE_CODE_/;
    const directApi = /api\.anthropic\.com/;

    const files = scannedRoots
      .flatMap((root) => walk(root))
      .filter((file) => /\.(ts|tsx|js|sh|md|ya?ml)$/.test(file))
      // Tests use fake credentials as fixtures.
      .filter((file) => !/\.test\.ts$/.test(file));

    const credentialOffenders = files
      .filter((file) => !claudeAuthFiles.has(file))
      .filter((file) => credentialPattern.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(ROOT, file));
    const directApiOffenders = files
      .filter((file) => !forwardsToApi.has(file))
      .filter((file) => directApi.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(ROOT, file));

    expect(credentialOffenders).toEqual([]);
    expect(directApiOffenders).toEqual([]);
  });

  it('setup service registration detects macOS, Linux systemd, root systemd, and nohup fallback', () => {
    const setupWizard = read('src/setup/index.ts');
    expect(setupWizard).toContain("process.platform === 'darwin'");
    expect(setupWizard).toContain("process.platform === 'linux' && hasSystemd()");
    expect(setupWizard).toContain('process.getuid?.() === 0');
    expect(setupWizard).toContain("'/etc/systemd/system'");
    expect(setupWizard).toContain('systemctl --user');
    expect(setupWizard).toContain('registerNohup');
    expect(setupWizard).toContain('nohup');
  });

  it('migration only treats ~/.clawbridge as legacy clawbridge-agent when provider is non-codex', () => {
    const migrate = read('src/setup/migrate.ts');
    expect(migrate).toContain("provider && provider !== 'codex'");
    expect(migrate).toContain("if (type === 'clawbridge') continue");
  });

  it('ships both providers in the container and keeps each SDK confined to its provider module', () => {
    const barrel = read('container/agent-runner/src/providers/index.ts');
    expect(barrel).toContain("import './claude.js';");
    expect(barrel).toContain("import './codex.js';");

    const dockerfile = read('container/Dockerfile');
    expect(dockerfile).toContain('ARG INSTALL_CLAUDE=true');
    expect(dockerfile).toContain('ARG INSTALL_CODEX=true');
    expect(dockerfile).toContain('@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}');
    expect(dockerfile).toContain('@openai/codex@${CODEX_VERSION}');

    expect(read('container/agent-runner/src/config.ts')).toContain('process.env.CLAWBRIDGE_PROVIDER');

    const sdkImporters = walk(path.join(ROOT, 'container', 'agent-runner', 'src'))
      .filter((file) => /\.ts$/.test(file))
      .filter((file) => /from '@anthropic-ai\//.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(ROOT, file));
    expect(sdkImporters).toEqual(['container/agent-runner/src/providers/claude.ts']);

    // The Codex provider must keep stripping API keys so it stays on subscription OAuth.
    const codexProvider = read('container/agent-runner/src/providers/codex.ts');
    expect(codexProvider).toContain("delete out['OPENAI_API_KEY']");
    expect(codexProvider).toContain("delete out['CODEX_API_KEY']");
  });

  it('scopes Hindsight memory per conversation and pins the server version', () => {
    for (const rel of ['src/router.ts', 'src/delivery.ts', 'src/host-sweep.ts']) {
      const content = read(rel);
      expect(content, rel).not.toMatch(
        /(recallToSessionFile|retainTurn|hindsightReflect|hindsightRecall|hindsightRetain)\(\s*'global'/,
      );
    }
    expect(read('src/router.ts')).toMatch(
      /recallToSessionFile\(\s*readableScopesForSession\(\{ agent_group_id: session\.agent_group_id, messaging_group_id: mg\.id \}\)/,
    );
    expect(read('src/delivery.ts')).toMatch(/retainTurn\(\s*memoryScopeForSession\(turnScope\)/);

    const hindsight = read('src/memory/hindsight.ts');
    expect(hindsight).not.toContain("tagsMatch: 'any_strict'");
    expect(hindsight).toContain("tagsMatch: 'all_strict'");

    const compose = read('integrations/docker-compose.yml');
    expect(compose).toMatch(/ghcr\.io\/vectorize-io\/hindsight:\d+\.\d+\.\d+/);
    expect(compose).not.toContain('vectorize-io/hindsight:latest');
  });

  it('keeps the system prompt cache-stable: memory recall rides in the user turn', () => {
    const claude = read('container/agent-runner/src/providers/claude.ts');
    expect(claude).not.toMatch(/memoryContext,\s*baseInstructions/);
    expect(claude).toContain('const instructions = input.systemContext?.instructions || undefined;');
    expect(claude).toContain('stream.push(memory.decorate(input.prompt))');

    const codex = read('container/agent-runner/src/providers/codex.ts');
    expect(codex).toContain('input.continuation ? undefined : input.systemContext?.instructions');
    expect(codex).toContain('state.pushQueue.push(memory.decorate(msg))');
  });

  it('keeps upgrade/update pointed at the codex package', () => {
    const updater = read('src/updater.ts');
    expect(updater).toContain("PACKAGE_NAME = 'clawbridge-ai'");
    expect(updater).toContain("CLI_NAME = 'clawbridge-ai'");
    expect(updater).not.toMatch(/clawbridge-agent\/latest|clawbridge-agent@latest|globalRoot, 'clawbridge-agent'/);
  });
});
