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

  it('writes both the page and the model with --model', async () => {
    collect.mockResolvedValue({ pulls: [pullData()], truncated: false, reachedWindowEdge: true, coveredSince: new Date('2026-02-01') });
    const tmpDir = tmp();
    const modelPath = path.join(tmpDir, 'model.json');
    const pagePath = path.join(tmpDir, 'index.html');
    const code = await main(['--out', pagePath, '--model', modelPath, '--repo', 'o/r']);
    expect(code).toBe(0);
    expect(existsSync(pagePath)).toBe(true);
    expect(existsSync(modelPath)).toBe(true);
    expect(readFileSync(pagePath, 'utf8')).toContain('Is test selection working?');
    expect(JSON.parse(readFileSync(modelPath, 'utf8'))).toMatchObject({ repo: 'o/r' });
  });

  it('the model with --model equals the model from --json', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-03T12:00:00Z'));
    try {
      const pullDataWithFixedDate = {
        pull: { number: 1, title: 'A pull request', url: 'https://github.com/o/r/pull/1', mergedAt: '2026-10-03T12:00:00Z' },
        prRun: null,
        mainRun: null,
        files: ['docs/notes.md'],
      };
      collect.mockResolvedValue({ pulls: [pullDataWithFixedDate], truncated: false, reachedWindowEdge: true, coveredSince: new Date('2026-02-01') });
      const tmpDir = tmp();
      const jsonOutput = path.join(tmpDir, 'a.json');
      const modelOutput = path.join(tmpDir, 'b.json');

      expect(await main(['--repo', 'o/r', '--json', '--out', jsonOutput])).toBe(0);
      collect.mockResolvedValue({ pulls: [pullDataWithFixedDate], truncated: false, reachedWindowEdge: true, coveredSince: new Date('2026-02-01') });
      expect(await main(['--repo', 'o/r', '--out', path.join(tmpDir, 'page.html'), '--model', modelOutput])).toBe(0);

      const jsonContent = readFileSync(jsonOutput, 'utf8');
      const modelContent = readFileSync(modelOutput, 'utf8');
      expect(jsonContent).toBe(modelContent);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses when --model and --out resolve to the same path', async () => {
    collect.mockResolvedValue({ pulls: [pullData()], truncated: false, reachedWindowEdge: true, coveredSince: new Date('2026-02-01') });
    const tmpDir = tmp();
    const samePath = path.join(tmpDir, 'model.json');

    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    try {
      expect(await main(['--repo', 'o/r', '--out', samePath, '--model', samePath])).toBe(2);
    } finally {
      process.stderr.write = write;
    }
    expect(existsSync(samePath)).toBe(false);
  });
});
