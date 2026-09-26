/**
 * github.js against a stubbed `fetch`: the shapes GitHub's API and artifact
 * download actually return, assembled the way collect() reads them. What
 * only this level can show is that the pieces (a run lookup, its jobs, its
 * artifacts, the zip inside one) are wired to each other correctly.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { collect, GitHubError } from '../../src/github.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });

/** A minimal, valid, uncompressed zip archive holding one `record.json` entry. */
function zipOf(json) {
  const content = Buffer.from(JSON.stringify(json), 'utf8');
  const name = Buffer.from('record.json', 'utf8');

  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);

  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  name.copy(central, 46);

  const localData = Buffer.concat([local, content]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(localData.length, 16);
  return Buffer.concat([localData, central, eocd]);
}

const rawPull = (overrides = {}) => ({
  number: 1,
  title: 'A pull request',
  html_url: 'https://github.com/o/r/pull/1',
  updated_at: '2026-02-10T00:00:00Z',
  merged_at: '2026-02-10T00:00:00Z',
  head: { sha: 'head1' },
  merge_commit_sha: 'merge1',
  ...overrides,
});

/** Routes the handful of endpoints collect() calls, by pattern. `stub` overrides one route per test. */
function stubApi(stub) {
  vi.stubGlobal('fetch', async (url) => {
    const filesMatch = url.match(/\/pulls\/(\d+)\/files/);
    if (filesMatch) return stub.files?.(filesMatch[1]) ?? ok([]);

    if (url.includes('/pulls?')) return stub.pulls?.() ?? ok([]);

    const runsMatch = url.match(/head_sha=([^&]+)&event=([^&]+)/);
    if (runsMatch) return stub.runs?.(decodeURIComponent(runsMatch[1]), runsMatch[2]) ?? ok({ workflow_runs: [] });

    const jobsMatch = url.match(/\/actions\/runs\/(\d+)\/jobs/);
    if (jobsMatch) return stub.jobs?.(jobsMatch[1]) ?? ok({ jobs: [] });

    const artifactsMatch = url.match(/\/actions\/runs\/(\d+)\/artifacts/);
    if (artifactsMatch) return stub.artifacts?.(artifactsMatch[1]) ?? ok({ artifacts: [] });

    const zipMatch = url.match(/\/actions\/artifacts\/(\d+)\/zip/);
    if (zipMatch) return stub.zip?.(zipMatch[1]) ?? { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => zipOf({ packages: [] }) };

    throw new Error(`unstubbed url in test: ${url}`);
  });
}

const runOf = (id, path = '.github/workflows/ci.yml') => ({ workflow_runs: [{ id, path, created_at: '2026-02-10T00:00:00Z' }] });

describe('collect', () => {
  it("reads a pull request's own record and main's record of its merge", async () => {
    stubApi({
      pulls: () => ok([rawPull()]),
      runs: (sha, event) => ok(sha === 'head1' && event === 'pull_request' ? runOf(11) : sha === 'merge1' && event === 'push' ? runOf(22) : { workflow_runs: [] }),
      artifacts: (runId) => ok({ artifacts: [{ id: Number(runId) * 100, name: 'test-selection-record', expired: false, created_at: '2026-02-10T01:00:00Z' }] }),
      zip: (artifactId) =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => null },
          arrayBuffer: async () => zipOf({ packages: [], run: Number(artifactId) }),
        }),
    });

    const collected = await collect({ repo: 'o/r', since: new Date('2026-02-01'), fetchImpl: fetch });
    expect(collected.pulls).toHaveLength(1);
    expect(collected.pulls[0].prRun.record).toEqual({ packages: [], run: 1100 });
    expect(collected.pulls[0].mainRun.record).toEqual({ packages: [], run: 2200 });
  });

  it('picks the newest non-expired artifact, as the run\'s last attempt', async () => {
    stubApi({
      pulls: () => ok([rawPull()]),
      runs: (sha, event) => ok(sha === 'head1' && event === 'pull_request' ? runOf(11) : { workflow_runs: [] }),
      artifacts: () =>
        ok({
          artifacts: [
            { id: 1, name: 'test-selection-record', expired: false, created_at: '2026-02-10T01:00:00Z' },
            { id: 2, name: 'test-selection-record', expired: false, created_at: '2026-02-10T02:00:00Z' },
            { id: 3, name: 'test-selection-record', expired: true, created_at: '2026-02-10T03:00:00Z' },
          ],
        }),
      zip: (artifactId) => ({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => zipOf({ artifactId: Number(artifactId) }) }),
    });

    const collected = await collect({ repo: 'o/r', since: new Date('2026-02-01'), fetchImpl: fetch });
    expect(collected.pulls[0].prRun.record).toEqual({ artifactId: 2 });
  });

  it('fails the run with a clear message, not a bare stack trace, when an artifact is not a readable zip', async () => {
    stubApi({
      pulls: () => ok([rawPull({ number: 7 })]),
      runs: (sha, event) => ok(sha === 'head1' && event === 'pull_request' ? runOf(11) : { workflow_runs: [] }),
      artifacts: () => ok({ artifacts: [{ id: 9, name: 'test-selection-record', expired: false, created_at: '2026-02-10T01:00:00Z' }] }),
      zip: () => ({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => Buffer.from('not a zip archive') }),
    });

    const failure = collect({ repo: 'o/r', since: new Date('2026-02-01'), fetchImpl: fetch });
    await expect(failure).rejects.toBeInstanceOf(GitHubError);
    await expect(failure).rejects.toThrow(/#7/);
  });

  it('reads a documentation-only pull request as having no run, and its changed files instead', async () => {
    stubApi({
      pulls: () => ok([rawPull()]),
      files: () => ok([{ filename: 'docs/notes.md' }]),
    });

    const collected = await collect({ repo: 'o/r', since: new Date('2026-02-01'), fetchImpl: fetch });
    expect(collected.pulls[0].prRun).toBeNull();
    expect(collected.pulls[0].files).toEqual(['docs/notes.md']);
  });

  it('fails the whole run, naming the pull request, when one of its requests fails after retries (Rule 7)', async () => {
    stubApi({
      pulls: () => ok([rawPull({ number: 42 })]),
      runs: () => ({ ok: false, status: 500, headers: { get: () => null } }),
    });

    await expect(collect({ repo: 'o/r', since: new Date('2026-02-01'), fetchImpl: fetch, retries: 0 })).rejects.toThrow(/#42/);
    await expect(collect({ repo: 'o/r', since: new Date('2026-02-01'), fetchImpl: fetch, retries: 0 })).rejects.toBeInstanceOf(GitHubError);
  });

  it('does not fail the run for a legitimately empty result — no run, no artifact, no files', async () => {
    stubApi({ pulls: () => ok([rawPull()]), files: () => ok([]) });
    const collected = await collect({ repo: 'o/r', since: new Date('2026-02-01'), fetchImpl: fetch });
    expect(collected.pulls[0].prRun).toBeNull();
    expect(collected.pulls[0].files).toEqual([]);
  });
});
