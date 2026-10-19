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

  describe('the alarm step', () => {
    /** One job's block of the workflow: from its key to the next job's. */
    const job = (key) => nightly.split(/\n  (?=[a-z-]+:\n    name: )/).find((block) => block.startsWith(`${key}:`)) ?? '';

    it('runs after the report is uploaded, with the workflow’s own token', () => {
      const selection = job('selection');
      const upload = selection.indexOf('actions/upload-artifact@v4');
      const alarm = selection.indexOf('node tools/selection/src/alarm-cli.js --model tools/selection/out/model.json');
      expect(upload).toBeGreaterThan(-1);
      expect(alarm).toBeGreaterThan(upload);
      expect(selection.slice(alarm)).toContain('GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
    });

    it('is granted write on issues on the Selection job alone', () => {
      const writers = ['cycle-time', 'selection', 'architecture', 'publish'].filter((key) => /issues:\s*write/.test(job(key)));
      expect(writers).toEqual(['selection']);
      expect(nightly.match(/issues:\s*write/g)).toHaveLength(1);
    });

    it('gains no other permission than that one', () => {
      const permissions = job('selection').match(/permissions:\n((?:      [a-z-]+: \w+\n)+)/)[1];
      expect(permissions.trim().split('\n').map((line) => line.trim())).toEqual(['contents: read', 'pull-requests: read', 'actions: read', 'issues: write']);
    });
  });
});