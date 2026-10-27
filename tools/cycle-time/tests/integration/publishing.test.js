/**
 * The wiring between this generator and nightly.yml, asserted by
 * reading the workflow files rather than by running anything.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const nightly = readFileSync(path.join(repo, '.github/workflows/nightly.yml'), 'utf8');

describe('the nightly cycle-time job, as nightly.yml assembles it', () => {
  it('works the model out and sends it, and draws and uploads no page', () => {
    expect(nightly).toContain('node tools/cycle-time/src/cli.js $send');
    expect(nightly).not.toContain('tools/cycle-time/out/index.html');
    expect(nightly).not.toContain('cycle-time-report');
    expect(nightly).not.toContain('lead-time-report');
    expect(nightly).not.toContain('tools/lead-time');
  });
});
