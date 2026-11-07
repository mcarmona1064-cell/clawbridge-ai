// npm "prepare": runs on `npm install` from a git checkout (including
// `npx github:owner/clawbridge-ai`). Builds dist/ when it is missing so the
// clawbridge-ai command works straight from GitHub, then sets up git hooks
// for contributors. Never fails the install.
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (!existsSync('dist/setup/index.js')) {
  try {
    execSync('npx tsc', { stdio: 'inherit' });
  } catch {
    console.error('clawbridge-ai: build failed; run `npm run build` to see why.');
  }
}
try {
  execSync('husky', { stdio: 'ignore' });
} catch {
  /* not a contributor checkout */
}
