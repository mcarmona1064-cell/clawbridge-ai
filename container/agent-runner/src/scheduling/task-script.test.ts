import { describe, expect, it } from 'bun:test';

import { scriptEnv } from './task-script.js';

describe('task script environment', () => {
  it('strips provider credentials but keeps ordinary variables', () => {
    const env = scriptEnv({
      PATH: '/usr/bin',
      TZ: 'UTC',
      ANTHROPIC_API_KEY: 'sk-ant-api-x',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-x',
      OPENAI_API_KEY: 'sk-x',
      GITHUB_TOKEN: 'ghp-x',
      SLACK_SIGNING_SECRET: 'x',
    });
    expect(env).toEqual({ PATH: '/usr/bin', TZ: 'UTC' });
  });
});
