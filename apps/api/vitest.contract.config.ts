import { readdirSync, readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import { contractFiles, suitesNamed } from '../../scripts/lib/contract-selection.mjs';
import { sessionRunReporter } from '../../scripts/lib/vitest-session-reporter.mjs';

/**
 * The contract tier: the tests that talk to the real Claude API
 * (docs/testing-strategy.md, "Third parties"). A config of its own, and not the
 * workers pool, for two reasons - these need no binding, no store and no
 * Worker, and they must never be picked up by `pnpm test`, which runs
 * `vitest run` over everything under `tests/` with the other config.
 *
 * **A behaviour suite runs only when it is named.** A run naming nothing - CI on
 * a pull request touching the AI layer, the weekly run, a bare
 * `pnpm --filter @cockpit/api test:contract` - makes one call per Claude prompt
 * (`one-call.test.ts`) and runs the free Workers AI suites. Each prompt's
 * behaviour suite spends real money and takes as long as the model does, so it
 * is run by hand, named, by whoever changes that prompt:
 * `pnpm --filter @cockpit/api test:contract clean-up-a-note`. Which files that
 * means is `scripts/lib/contract-selection.mjs`. A failure here is the API, the
 * model or the prompt having drifted, and fixing it is priority work rather
 * than something to re-run until it passes.
 */

const here = new URL('.', import.meta.url);
const suites = readdirSync(new URL('tests/contract/', here)).filter((file) => file.endsWith('.test.ts'));

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
    const match = /^\s*((?:ANTHROPIC|CLOUDFLARE)_[A-Z_]+)\s*=\s*(.*)$/.exec(line);
    if (match) found[match[1]!] = match[2]!.trim().replace(/^["']|["']$/g, '');
  }
  return found;
}

const onDisk = fromDevVars();

export default defineConfig({
  test: {
    reporters: ['default', sessionRunReporter],
    include: contractFiles(suites, suitesNamed(process.argv)).map((file) => `tests/contract/${file}`),
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
    },
  },
});
