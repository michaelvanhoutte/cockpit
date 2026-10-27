/**
 * The wiring between this generator and the published site, asserted by reading
 * `ci.yml` and `nightly.yml` rather than by running anything, as the `Scripts`
 * job's own tests do for the conventions no runnable test can reach.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const ci = readFileSync(path.join(repo, '.github/workflows/ci.yml'), 'utf8');

describe("the nightly send of the branches' attempts, as nightly.yml wires it", () => {
  const nightly = readFileSync(path.join(repo, '.github/workflows/nightly.yml'), 'utf8');
  const job = nightly.slice(nightly.indexOf('  branch-attempts:'), nightly.indexOf('  architecture:'));

  it('runs the branches mode with --send, and writes no model', () => {
    expect(job).toContain('node tools/ci-stability/src/cli.js --branches --send');
    expect(job).not.toContain('--model');
    expect(job).not.toContain('upload-artifact');
  });

  it('hands the write key over on main only, and sends nothing, passing, until both it and the address are set', () => {
    expect(job).toContain("HARNESS_WRITE_KEY: ${{ github.ref == 'refs/heads/main' && secrets.HARNESS_WRITE_KEY || '' }}");
    expect(job).toContain('HARNESS_MONITOR_URL: ${{ vars.HARNESS_MONITOR_URL }}');
    expect(job).toMatch(/\[ -z "\$HARNESS_WRITE_KEY" \] \|\| \[ -z "\$HARNESS_MONITOR_URL" \][\s\S]*?::notice[\s\S]*?exit 0/);
  });

  it('reads the Actions API and writes nothing to GitHub', () => {
    expect(job).toMatch(/permissions:\n\s+contents: read\n\s+actions: read\n/);
    expect(job).not.toMatch(/: write/);
  });
});

describe('the stability job, as ci.yml assembles it', () => {
  const job = ci.slice(ci.indexOf('  stability:'), ci.indexOf('  pages:'));

  it('works the model out and sends it, and draws and uploads no page', () => {
    expect(job).toContain('node tools/ci-stability/src/cli.js $send');
    expect(ci).not.toContain('tools/ci-stability/out/index.html');
    expect(ci).not.toContain('ci-stability-report');
  });

  it('grants the stability job no write anywhere, since it only reads', () => {
    const permissions = job.slice(job.indexOf('permissions:'), job.indexOf('continue-on-error'));
    expect(permissions).toContain('actions: read');
    expect(permissions).not.toContain('write');
  });
});
