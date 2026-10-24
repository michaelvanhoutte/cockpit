/**
 * The whole pipeline, argv in and a real file on disk out — everything below
 * this level (fetching, the model, the page) is covered by its own unit and
 * integration tests; what only this level can show is that the three halves
 * are wired to each other and that a failed fetch writes nothing.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GitHubError } from '../../src/github.js';

vi.mock('../../src/github.js', async (importOriginal) => ({ ...(await importOriginal()), collect: vi.fn() }));

vi.mock('../../src/issues.js', async (importOriginal) => ({ ...(await importOriginal()), listAlarmIssues: vi.fn() }));

const { collect } = await import('../../src/github.js');
const { listAlarmIssues } = await import('../../src/issues.js');
const { main } = await import('../../src/cli.js');

const dirs = [];
const tmp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'selection-'));
  dirs.push(dir);
  return dir;
};

beforeEach(() => {
  listAlarmIssues.mockResolvedValue([]);
});

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
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const tmpDir = tmp();
    const samePath = path.join(tmpDir, 'model.json');
    try {
      expect(await main(['--repo', 'o/r', '--out', samePath, '--model', samePath])).toBe(2);
      expect(collect).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
    expect(existsSync(samePath)).toBe(false);
  });

  it('records the open alarm of a bar in the model, which is what the page links', async () => {
    collect.mockResolvedValue({ pulls: [pullData()], truncated: false, reachedWindowEdge: true, coveredSince: new Date('2026-02-01') });
    listAlarmIssues.mockResolvedValue([{ number: 41, state: 'open', title: 'Selection: misses', body: '<!-- selection-alarm bar=misses first=2026-02-01 last=2026-02-02 -->', comments: [] }]);
    const out = path.join(tmp(), 'model.json');
    expect(await main(['--out', out, '--repo', 'o/r', '--json'])).toBe(0);
    const bars = Object.fromEntries(JSON.parse(readFileSync(out, 'utf8')).bars.items.map((bar) => [bar.id, bar.alarmIssue]));
    expect(bars.misses).toBe(41);
    expect(bars['e2e-forced-full']).toBeNull();
  });

  describe('--send sends the pull requests to the Harness Monitor from the newest merge it holds, less two days', () => {
    const NIGHT = new Date('2026-10-24T02:00:00Z');
    const merged = (number, mergedAt) => pullData({ pull: { number, title: `Pull ${number}`, url: `https://github.com/o/r/pull/${number}`, mergedAt }, files: ['docs/notes.md'] });
    const read = (pulls, extra = {}) => ({ pulls, truncated: false, reachedWindowEdge: true, coveredSince: new Date('2026-10-01'), ...extra });

    /** A Monitor holding pull requests up to `newestMerge`, which stores what it is sent unless it `refuses`. */
    function theMonitor({ newestMerge = '2026-10-22T08:00:00.000Z', refuses = false } = {}) {
      const posts = [];
      let asked = 0;
      vi.stubGlobal('fetch', async (url, init) => {
        if (init?.method === 'POST') {
          posts.push(JSON.parse(init.body));
          return refuses ? { ok: false, status: 400, json: async () => ({ error: 'Pull request 0 (#1): has no title.' }) } : { ok: true, status: 200, json: async () => ({ stored: 1 }) };
        }
        asked += 1;
        return { ok: true, status: 200, json: async () => ({ newestMerge }) };
      });
      return { posts, asked: () => asked };
    }

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NIGHT);
      vi.stubEnv('HARNESS_MONITOR_URL', 'https://monitor.test');
      vi.stubEnv('HARNESS_WRITE_KEY', 'k');
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it('sends only the pull requests merged since two days before the newest stored merge, with the bars, and still writes the page', async () => {
      const monitor = theMonitor();
      collect.mockResolvedValue(read([merged(1, '2026-10-23T10:00:00Z'), merged(2, '2026-10-19T10:00:00Z'), merged(3, '2026-10-21T10:00:00Z')]));
      const out = path.join(tmp(), 'index.html');

      const code = await main(['--send', '--out', out, '--repo', 'o/r']);

      expect(code).toBe(0);
      expect(collect.mock.calls[0][0].since).toEqual(new Date('2026-10-10T02:00:00Z'));
      expect(monitor.posts).toHaveLength(1);
      expect(monitor.posts[0].pulls.map((pull) => pull.number)).toEqual([3, 1]);
      expect(monitor.posts[0].bars.items.map((bar) => bar.id)).toEqual(['e2e-forced-full', 'test-forced-full', 'misses', 'most-selected']);
      expect(existsSync(out)).toBe(true);
    });

    it('reads back to two days before the newest stored merge when that is further back than the page goes', async () => {
      theMonitor({ newestMerge: '2026-10-01T08:00:00.000Z' });
      collect.mockResolvedValue(read([merged(1, '2026-10-23T10:00:00Z')]));

      expect(await main(['--send', '--out', path.join(tmp(), 'index.html'), '--repo', 'o/r'])).toBe(0);

      expect(collect.mock.calls[0][0].since).toEqual(new Date('2026-09-29T08:00:00Z'));
    });

    it('reads from the page window when the Monitor holds nothing', async () => {
      const monitor = theMonitor({ newestMerge: null });
      collect.mockResolvedValue(read([merged(1, '2026-10-23T10:00:00Z')]));

      expect(await main(['--send', '--out', path.join(tmp(), 'index.html'), '--repo', 'o/r', '--days', '5'])).toBe(0);

      expect(collect.mock.calls[0][0].since).toEqual(new Date('2026-10-19T02:00:00Z'));
      expect(monitor.posts[0].pulls.map((pull) => pull.number)).toEqual([1]);
    });

    it('sends the open alarm issues with the bars, and none where they could not be read, so the Monitor keeps the ones it holds', async () => {
      const monitor = theMonitor();
      collect.mockResolvedValue(read([merged(1, '2026-10-23T10:00:00Z')]));
      listAlarmIssues.mockResolvedValueOnce([{ number: 41, state: 'open', title: 'Selection: misses', body: '<!-- selection-alarm bar=misses first=2026-10-01 last=2026-10-02 -->', comments: [] }]);
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        await main(['--send', '--out', path.join(tmp(), 'a.html'), '--repo', 'o/r']);
        listAlarmIssues.mockRejectedValueOnce(new Error('GitHub answered 502'));
        await main(['--send', '--out', path.join(tmp(), 'b.html'), '--repo', 'o/r']);
      } finally {
        stderr.mockRestore();
      }

      expect(monitor.posts[0].bars.items.find((bar) => bar.id === 'misses').alarmIssue).toBe(41);
      expect(monitor.posts[1].bars.items.some((bar) => 'alarmIssue' in bar)).toBe(false);
    });

    it('a Monitor that refuses the send costs the send and never the page, and the run fails', async () => {
      theMonitor({ refuses: true });
      collect.mockResolvedValue(read([merged(1, '2026-10-23T10:00:00Z')]));
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const out = path.join(tmp(), 'index.html');
      try {
        expect(await main(['--send', '--out', out, '--repo', 'o/r'])).toBe(1);
        expect(stderr.mock.calls.join('')).toContain('refused batch 1 of 1 (400: Pull request 0 (#1): has no title.)');
      } finally {
        stderr.mockRestore();
      }
      expect(existsSync(out)).toBe(true);
    });

    it('a Monitor that cannot say where to start costs the send and never the page', async () => {
      vi.stubGlobal('fetch', async () => ({ ok: false, status: 502 }));
      collect.mockResolvedValue(read([merged(1, '2026-10-23T10:00:00Z')]));
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const out = path.join(tmp(), 'index.html');
      try {
        expect(await main(['--send', '--out', out, '--repo', 'o/r'])).toBe(1);
      } finally {
        stderr.mockRestore();
      }
      expect(existsSync(out)).toBe(true);
    });

    it('a read the pull budget stopped inside the window sends what it read and fails, naming the backfill for the rest', async () => {
      const monitor = theMonitor();
      collect.mockResolvedValue(read([merged(1, '2026-10-23T10:00:00Z')], { truncated: true, coveredSince: new Date('2026-10-22T00:00:00Z') }));
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        expect(await main(['--send', '--out', path.join(tmp(), 'index.html'), '--repo', 'o/r'])).toBe(1);
        expect(stderr.mock.calls.join('')).toContain('the Selection backfill, --from 2026-10-20 --to 2026-10-22');
      } finally {
        stderr.mockRestore();
      }
      expect(monitor.posts).toHaveLength(1);
    });

    it('a window given by hand is the backfill: it sends that window and writes no page', async () => {
      const monitor = theMonitor();
      collect.mockResolvedValue(read([merged(1, '2026-09-03T10:00:00Z')]));
      const out = path.join(tmp(), 'index.html');

      expect(await main(['--send', '--from', '2026-09-01', '--to', '2026-09-05', '--out', out, '--repo', 'o/r'])).toBe(0);

      expect(monitor.asked()).toBe(0);
      expect(collect.mock.calls[0][0]).toMatchObject({ since: new Date('2026-09-01T00:00:00Z'), until: new Date('2026-09-06T00:00:00Z') });
      expect(monitor.posts[0].pulls.map((pull) => pull.number)).toEqual([1]);
      expect(existsSync(out)).toBe(false);
    });

    it('without the key or the address it refuses before reading anything', async () => {
      vi.stubEnv('HARNESS_WRITE_KEY', '');
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        expect(await main(['--send', '--repo', 'o/r'])).toBe(2);
      } finally {
        stderr.mockRestore();
      }
      expect(collect).not.toHaveBeenCalled();
    });
  });

  it('writes the page without links when the alarm issues cannot be read, rather than losing the report', async () => {
    collect.mockResolvedValue({ pulls: [pullData()], truncated: false, reachedWindowEdge: true, coveredSince: new Date('2026-02-01') });
    listAlarmIssues.mockRejectedValue(new Error('GitHub answered 502'));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = path.join(tmp(), 'index.html');
    try {
      expect(await main(['--out', out, '--repo', 'o/r'])).toBe(0);
    } finally {
      stderr.mockRestore();
    }
    expect(readFileSync(out, 'utf8')).toContain('Is test selection working?');
  });
});