/**
 * The whole pipeline, argv in and a real file on disk out — everything below
 * this level (fetching, the model, the page) is covered by its own unit and
 * integration tests; what only this level can show is that the three halves
 * are wired to each other and that a failed fetch writes nothing.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { GitHubError } from '../../src/github.js';

vi.mock('../../src/github.js', async (importOriginal) => ({ ...(await importOriginal()), collect: vi.fn() }));

const { collect } = await import('../../src/github.js');
const { main } = await import('../../src/cli.js');

const dirs = [];
const tmp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'selection-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const pullData = (overrides = {}) => ({
  pull: { number: 1, title: 'A pull request', url: 'https://github.com/o/r/pull/1', mergedAt: new Date().toISOString() },
  prRun: null,
  mainRun: null,
  files: ['docs/notes.md'],
  ...overrides,
});

describe('main', () => {
  it('writes the page and exits 0', async () => {
    collect.mockResolvedValue({ pulls: [pullData()], truncated: false, reachedWindowEdge: true, coveredSince: new Date('2026-02-01') });
    const out = path.join(tmp(), 'index.html');
    const code = await main(['--out', out, '--repo', 'o/r']);
    expect(code).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, 'utf8')).toContain('Is test selection working?');
  });

  it('writes the model instead, with --json', async () => {
    collect.mockResolvedValue({ pulls: [pullData()], truncated: false, reachedWindowEdge: true, coveredSince: new Date('2026-02-01') });
    const out = path.join(tmp(), 'model.json');
    const code = await main(['--out', out, '--repo', 'o/r', '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({ repo: 'o/r' });
  });

  it('exits 1 and writes nothing when the fetch fails', async () => {
    collect.mockRejectedValue(new GitHubError("GitHub's rate limit is spent", { reason: 'rate-limit' }));
    const out = path.join(tmp(), 'index.html');
    const code = await main(['--out', out, '--repo', 'o/r']);
    expect(code).toBe(1);
    expect(existsSync(out)).toBe(false);
  });
});
