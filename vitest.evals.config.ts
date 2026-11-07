import { defineConfig } from 'vitest/config';

// Eval suite: two-sided scenarios against the real host code, on both
// providers, pass^3. Separate from unit tests; runs nightly in CI.
export default defineConfig({
  test: {
    include: ['evals/**/*.eval.ts'],
  },
});
