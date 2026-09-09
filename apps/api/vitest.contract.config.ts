import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

/**
 * The contract tier: the tests that talk to the real Claude API
 * (docs/testing-strategy.md, "Third parties"). A config of its own, and not the
 * workers pool, for two reasons - these need no binding, no store and no
 * Worker, and they must never be picked up by `pnpm test`, which runs
 * `vitest run` over everything under `tests/` with the other config.
 *
 * **Scheduled only**, because every run spends real money and takes as long as
 * the model does: `.github/workflows/contract.yml` runs it nightly, and
 * `pnpm --filter @cockpit/api test:contract` runs it by hand. A failure here is
 * the model or the prompt having drifted, and fixing it is priority work rather
 * than something to re-run until it passes.
 */

/**
 * The key from `.dev.vars`, so running this by hand needs nothing exported
 * first - the same file `pnpm dev` reads. An environment variable still wins,
 * which is what CI sets and what keeps the secret out of a file on a runner.
 *
 * Values are read and passed on, never logged: the failure this file would
 * otherwise invite is a key in a CI log.
 */
function fromDevVars(): Record<string, string> {
  let file: string;
  try {
    file = readFileSync(new URL('.dev.vars', import.meta.url), 'utf8');
  } catch {
    return {};
  }
  const found: Record<string, string> = {};
  for (const line of file.split(/\r?\n/)) {
    const match = /^\s*(ANTHROPIC_[A-Z_]+)\s*=\s*(.*)$/.exec(line);
    if (match) found[match[1]!] = match[2]!.trim().replace(/^["']|["']$/g, '');
  }
  return found;
}

const onDisk = fromDevVars();

export default defineConfig({
  test: {
    include: ['tests/contract/**/*.test.ts'],
    // The model is what takes the time here, not the assertions.
    testTimeout: 120_000,
    env: {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? onDisk.ANTHROPIC_API_KEY ?? '',
      ANTHROPIC_WORKSPACE_ID:
        process.env.ANTHROPIC_WORKSPACE_ID ?? onDisk.ANTHROPIC_WORKSPACE_ID ?? '',
    },
  },
});
