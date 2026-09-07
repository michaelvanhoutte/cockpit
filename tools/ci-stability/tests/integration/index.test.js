/**
 * The whole pipeline against a stubbed API: argv in, a real file on disk out.
 * Everything below this level is covered by the unit tests; what only this
 * level can show is that the three halves are wired to each other and that a
 * failed fetch leaves nothing behind.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from '../../src/cli.js';

const dirs = [];
const tmp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ci-stability-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });

function stubApi({ runs = [], jobs = [] } = {}) {
  vi.stubGlobal('fetch', async (url) => {
    if (url.includes('/jobs')) return ok({ jobs });
    const page = Number(url.match(/[?&]page=(\d+)/)?.[1] ?? 1);
    return ok({ workflow_runs: page === 1 ? runs : [] });
  });
}

const rawRun = (overrides = {}) => ({
  id: 1,
  name: 'CI',
  path: '.github/workflows/ci.yml',
  event: 'push',
  conclusion: 'failure',
  status: 'completed',
  head_sha: 'deadbeef1234',
  created_at: new Date(Date.now() - 3_600_000).toISOString(),
  run_attempt: 1,
  html_url: 'https://github.com/o/r/actions/runs/1',
  ...overrides,
});

const rawJob = (overrides = {}) => ({
  run_id: 1,
  name: 'E2E (F3)',
  conclusion: 'failure',
  status: 'completed',
  started_at: new Date(Date.now() - 3_600_000).toISOString(),
  completed_at: new Date(Date.now() - 3_300_000).toISOString(),
  html_url: 'https://github.com/o/r/actions/runs/1/job/9',
  steps: [{ name: 'Run pnpm test:e2e', conclusion: 'failure' }],
  ...overrides,
});

describe('the generator, end to end against a stubbed API', () => {
  it('writes a page carrying the failing job, its step and a link back to the test explorer', async () => {
    stubApi({ runs: [rawRun()], jobs: [rawJob()] });
    const out = path.join(tmp(), 'stability', 'index.html');

    expect(await main(['--repo', 'o/r', '--out', out])).toBe(0);

    const html = readFileSync(out, 'utf8');
    expect(html).toContain('<title>Cockpit CI Stability</title>');
    expect(html).toContain('E2E (F3)');
    expect(html).toContain('Run pnpm test:e2e');
    expect(html).toContain('href="../"');
    // The directory it was told to write to did not exist; a report that only
    // works into an existing tree would fail on the first CI run of a fresh
    // checkout.
    expect(existsSync(out)).toBe(true);
  });

  it('writes the model instead of the page when asked for it, so something else can read the numbers', async () => {
    stubApi({ runs: [rawRun({ conclusion: 'success' })], jobs: [rawJob({ conclusion: 'success' })] });
    const out = path.join(tmp(), 'model.json');

    expect(await main(['--repo', 'o/r', '--out', out, '--json'])).toBe(0);

    const model = JSON.parse(readFileSync(out, 'utf8'));
    expect(model.repo).toBe('o/r');
    expect(model.windows[0].workflows[0].jobs[0].tally.rate).toBe(1);
  });

  it('writes no page at all when the API refuses, rather than one full of plausible zeroes', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 403,
      headers: { get: (name) => (name === 'x-ratelimit-remaining' ? '0' : null) },
      json: async () => ({}),
    }));
    const out = path.join(tmp(), 'index.html');

    expect(await main(['--repo', 'o/r', '--out', out])).toBe(1);
    expect(existsSync(out)).toBe(false);
  });

  it('refuses an argument it does not know instead of quietly reporting on the wrong thing', async () => {
    const written = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => written.push(String(chunk));
    try {
      expect(await main(['--branhc', 'main'])).toBe(2);
    } finally {
      process.stderr.write = write;
    }
    // The misspelled flag, not the value behind it.
    expect(written.join('')).toContain('unknown argument: --branhc');
  });

  it('refuses a budget that is not a number, rather than fetching without one', async () => {
    // NaN would not shrink the budget, it would remove it: every comparison
    // against NaN is false, so the fetch would read the whole run history.
    const fetched = [];
    vi.stubGlobal('fetch', async (url) => {
      fetched.push(url);
      return ok({ workflow_runs: [] });
    });
    const written = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => written.push(String(chunk));
    try {
      expect(await main(['--repo', 'o/r', '--max-runs', '8OO'])).toBe(2);
      expect(await main(['--repo', 'o/r', '--days', 'thirty'])).toBe(2);
    } finally {
      process.stderr.write = write;
    }
    expect(written.join('')).toContain('--max-runs needs a positive number');
    expect(fetched).toEqual([]);
  });
});
