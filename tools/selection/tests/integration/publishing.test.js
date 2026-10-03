/**
 * The wiring between this generator and nightly.yml, asserted by reading
 * the workflow file rather than by running anything.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const nightly = readFileSync(path.join(repo, '.github/workflows/nightly.yml'), 'utf8');

describe('the nightly selection job, as nightly.yml assembles it', () => {
  it('writes the report with both --out and --model', () => {
    expect(nightly).toContain('--out tools/selection/out/index.html --model tools/selection/out/model.json');
    expect(nightly).toContain('path: tools/selection/out/');
  });
});
