import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

/**
 * The contract tier: the tests that talk to the real Claude API
 * (docs/testing-strategy.md, "Third parties"). A config of its own, and not the
 * workers pool, for two reasons - these need no binding, no store and no
 * Worker, and they must never be picked up by `pnpm test`, which runs
 * `vitest run` over everything under `tests/` with the other config.
 *
 * **The Claude suites never run on a schedule**, because every run spends real money and takes as long as
 * the model does: `.github/workflows/contract.yml` runs them on a pull request that
 * touches the AI layer, and `pnpm --filter @cockpit/api test:contract` runs them by hand. Its weekly run
 * names only the Gmail and meaning suites and withholds the Claude key. A failure here is
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
    const match = /^\s*((?:ANTHROPIC|CLOUDFLARE|GMAIL_CONTRACT)_[A-Z_]+)\s*=\s*(.*)$/.exec(line);
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
      // The account Workers AI is reached in, and a token for it - what reads
      // meaning ("Flag a captured note that says what another one already
      // said", issue 407). A deployment reaches the same model through a
      // binding and needs neither; this tier has no Worker to hold one.
      CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID ?? onDisk.CLOUDFLARE_ACCOUNT_ID ?? '',
      CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN ?? onDisk.CLOUDFLARE_API_TOKEN ?? '',
      // A dedicated test mailbox's sign-in, for what Gmail answers ("Bring in
      // the conversations already labelled Cockpit as tasks", issue 725):
      // the Google client it was made through, and its refresh token. Without
      // all three that suite skips (tests/contract/gmail.test.ts).
      GMAIL_CONTRACT_CLIENT_ID: process.env.GMAIL_CONTRACT_CLIENT_ID ?? onDisk.GMAIL_CONTRACT_CLIENT_ID ?? '',
      GMAIL_CONTRACT_CLIENT_SECRET: process.env.GMAIL_CONTRACT_CLIENT_SECRET ?? onDisk.GMAIL_CONTRACT_CLIENT_SECRET ?? '',
      GMAIL_CONTRACT_REFRESH_TOKEN: process.env.GMAIL_CONTRACT_REFRESH_TOKEN ?? onDisk.GMAIL_CONTRACT_REFRESH_TOKEN ?? '',
    },
  },
});
