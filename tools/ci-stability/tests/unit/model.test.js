import { describe, expect, it } from 'vitest';

import { buildModel, classify, quantiles, redWindows, tally } from '../../src/model.js';

const NOW = new Date('2026-09-07T12:00:00Z');

/** Days before NOW, as the ISO string the API would have returned. */
const ago = (days, hours = 0) =>
  new Date(NOW.getTime() - days * 86_400_000 - hours * 3_600_000).toISOString();

let nextId = 1;
const run = (overrides = {}) => ({
  id: nextId++,
  workflow: 'CI',
  path: '.github/workflows/ci.yml',
  event: 'push',
  conclusion: 'success',
  status: 'completed',
  headSha: 'aaaaaaa',
  createdAt: ago(1),
  attempt: 1,
  url: 'https://github.com/o/r/actions/runs/1',
  ...overrides,
});

const job = (overrides = {}) => ({
  runId: 1,
  name: 'Test',
  conclusion: 'success',
  status: 'completed',
  startedAt: '2026-09-06T12:00:00Z',
  completedAt: '2026-09-06T12:01:00Z',
  failedStep: null,
  url: 'https://github.com/o/r/actions/runs/1/job/1',
  ...overrides,
});

const build = (overrides = {}) =>
  buildModel({
    runs: [],
    jobs: [],
    now: NOW,
    requestedDays: 30,
    truncated: false,
    repo: 'o/r',
    ...overrides,
  });

describe('classify', () => {
  it('reads a cancellation as its own outcome, never as a failure', () => {
    expect(classify({ status: 'completed', conclusion: 'cancelled' })).toBe('cancelled');
  });

  it('reads a run that has not finished as running, whatever its empty conclusion looks like', () => {
    expect(classify({ status: 'in_progress', conclusion: null })).toBe('running');
    expect(classify({ status: 'queued', conclusion: null })).toBe('running');
  });

  it('counts a timeout and a startup failure as failures, because both mean the check did not pass', () => {
    expect(classify({ status: 'completed', conclusion: 'timed_out' })).toBe('fail');
    expect(classify({ status: 'completed', conclusion: 'startup_failure' })).toBe('fail');
  });

  it('refuses to guess at a conclusion it does not know, rather than reading it as success', () => {
    expect(classify({ status: 'completed', conclusion: 'invented_next_year' })).toBe('unknown');
  });
});

describe('tally', () => {
  it('counts only what finished, and keeps what it left out', () => {
    const counts = tally(['pass', 'pass', 'fail', 'cancelled', 'skipped', 'running', 'unknown']);
    expect(counts.completed).toBe(3);
    expect(counts.rate).toBeCloseTo(2 / 3);
    expect(counts.cancelled).toBe(1);
    expect(counts.skipped).toBe(1);
    expect(counts.running).toBe(1);
    expect(counts.unknown).toBe(1);
  });

  it('has no rate at all when nothing finished, rather than a rate of zero', () => {
    expect(tally(['cancelled', 'running']).rate).toBeNull();
  });
});

describe('quantiles', () => {
  it('reports a single run as both the median and the p90, which is all one run can say', () => {
    expect(quantiles([90])).toEqual({ median: 90, p90: 90, count: 1 });
  });

  it('has a median over an even number of runs', () => {
    expect(quantiles([10, 20, 30, 40]).median).toBe(25);
  });

  it('reports a p90 that a run really took', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(quantiles(values).p90).toBe(9);
  });

  it('has nothing to say about a job that never finished', () => {
    expect(quantiles([])).toBeNull();
  });
});

describe('redWindows', () => {
  it('closes a stretch at the next passing run, and counts the commits it spanned', () => {
    const windows = redWindows(
      [
        run({ conclusion: 'failure', headSha: 'bad1', createdAt: ago(2) }),
        run({ conclusion: 'success', headSha: 'good', createdAt: ago(1) }),
      ],
      { now: NOW },
    );
    expect(windows).toHaveLength(1);
    expect(windows[0].ongoing).toBe(false);
    expect(windows[0].ms).toBe(86_400_000);
    expect(windows[0].commits).toBe(1);
  });

  it('treats two failures in a row as one stretch, because the question is how long it was red', () => {
    const windows = redWindows(
      [
        run({ conclusion: 'failure', headSha: 'bad1', createdAt: ago(3) }),
        run({ conclusion: 'failure', headSha: 'bad2', createdAt: ago(2) }),
        run({ conclusion: 'success', createdAt: ago(1) }),
      ],
      { now: NOW },
    );
    expect(windows).toHaveLength(1);
    expect(windows[0].commits).toBe(2);
  });

  it('lets a cancelled run neither open nor close a stretch, since it is evidence of nothing', () => {
    const windows = redWindows(
      [
        run({ conclusion: 'failure', headSha: 'bad1', createdAt: ago(3) }),
        run({ conclusion: 'cancelled', headSha: 'cancelled', createdAt: ago(2) }),
        run({ conclusion: 'success', createdAt: ago(1) }),
      ],
      { now: NOW },
    );
    expect(windows).toHaveLength(1);
    expect(windows[0].commits).toBe(1);
    expect(windows[0].until).toBe(ago(1));
  });

  it('reports a stretch nothing has closed yet as still open, measured to now', () => {
    const windows = redWindows([run({ conclusion: 'failure', createdAt: ago(0, 2) })], { now: NOW });
    expect(windows[0].ongoing).toBe(true);
    expect(windows[0].ms).toBe(2 * 3_600_000);
  });
});

describe('buildModel', () => {
  it('rates a job over the runs it appeared in, so a job added yesterday is not judged on last month', () => {
    const old = run({ createdAt: ago(20) });
    const recent = run({ createdAt: ago(1) });
    const model = build({
      runs: [old, recent],
      jobs: [
        job({ runId: old.id, name: 'Test' }),
        job({ runId: recent.id, name: 'Test' }),
        job({ runId: recent.id, name: 'Publish' }),
      ],
      windows: [30],
    });

    const jobs = model.windows[0].workflows[0].jobs;
    expect(jobs.find((j) => j.name === 'Test').tally.completed).toBe(2);
    expect(jobs.find((j) => j.name === 'Publish').tally.completed).toBe(1);
  });

  it('keeps a renamed job as two rows, rather than inventing a continuity the API never gave', () => {
    const first = run({ createdAt: ago(5) });
    const second = run({ createdAt: ago(1) });
    const model = build({
      runs: [first, second],
      jobs: [job({ runId: first.id, name: 'E2E' }), job({ runId: second.id, name: 'E2E (F3)' })],
      windows: [30],
    });
    expect(model.windows[0].workflows[0].jobs.map((j) => j.name).sort()).toEqual(['E2E', 'E2E (F3)']);
  });

  it('rates a workflow on its own verdict, not on the average of the jobs inside it', () => {
    // Nine jobs passed and one failed, so a mean over jobs would read 90%; the run
    // failed, and a workflow that failed is a workflow that failed.
    const failed = run({ conclusion: 'failure' });
    const model = build({
      runs: [failed],
      jobs: [
        ...Array.from({ length: 9 }, (_, i) => job({ runId: failed.id, name: `Job ${i}` })),
        job({ runId: failed.id, name: 'Job 9', conclusion: 'failure' }),
      ],
      windows: [30],
    });
    expect(model.windows[0].workflows[0].tally.rate).toBe(0);
  });

  it('reports a job nobody has finished as having no data, so it does not head a worst-first list', () => {
    const only = run({ conclusion: 'cancelled' });
    const model = build({
      runs: [only],
      jobs: [job({ runId: only.id, name: 'E2E (F3)', conclusion: 'cancelled' })],
      windows: [30],
    });
    const [job0] = model.windows[0].workflows[0].jobs;
    expect(job0.tally.rate).toBeNull();
    expect(job0.tally.cancelled).toBe(1);
  });

  it('says a window is partial when history does not reach back that far', () => {
    const model = build({ runs: [run({ createdAt: ago(10) })], requestedDays: 30, windows: [7, 30] });
    expect(model.coverage.partial).toBe(true);
    expect(Math.round(model.coverage.actualDays)).toBe(10);
    expect(model.windows[0].partial).toBe(false);
    expect(model.windows[1].partial).toBe(true);
    expect(Math.round(model.windows[1].actualDays)).toBe(10);
  });

  it('says a window is partial when the run budget stopped the fetch, not only when history is short', () => {
    const model = build({ runs: [run({ createdAt: ago(29) })], truncated: true });
    expect(model.coverage.partial).toBe(true);
    expect(model.coverage.truncated).toBe(true);
  });

  it('calls nothing partial when history reaches past the window', () => {
    // Every run the fetch returns is inside the window by construction, so the
    // oldest one cannot tell a year of history from a week. Having *seen* an
    // older run is the evidence; without this the banner reads "This covers 30
    // days, not 30" on a repository with years behind it.
    const model = build({
      runs: [run({ createdAt: ago(29) }), run({ createdAt: ago(1) })],
      requestedDays: 30,
      reachedWindowEdge: true,
      windows: [7, 30],
    });
    expect(model.coverage.partial).toBe(false);
    expect(model.windows[0].partial).toBe(false);
    expect(model.windows[1].partial).toBe(false);
    expect(model.windows[1].actualDays).toBe(30);
  });

  it('never calls a window whole when the fetch did not go back as far as the window does', () => {
    // `--days 7` with the default `--windows 7,30`, which the README's own
    // example invocation produces: the fetch reaches the edge of its seven days,
    // which says nothing about the thirty the second column claims.
    const model = build({
      runs: [run({ createdAt: ago(6) })],
      requestedDays: 7,
      reachedWindowEdge: true,
      windows: [7, 30],
    });
    expect(model.windows[0].partial).toBe(false);
    expect(model.windows[1].partial).toBe(true);
    expect(Math.round(model.windows[1].actualDays)).toBe(6);
  });

  it('still calls the shorter window whole when only the longer one runs out of history', () => {
    const model = build({
      runs: [run({ createdAt: ago(10) })],
      requestedDays: 30,
      reachedWindowEdge: false,
      windows: [7, 30],
    });
    expect(model.windows[0].partial).toBe(false);
    expect(model.windows[1].partial).toBe(true);
  });

  it('leaves a job with no finish time out of the durations while keeping it in the rate', () => {
    const only = run();
    const model = build({
      runs: [only],
      jobs: [job({ runId: only.id, completedAt: null })],
      windows: [30],
    });
    const [job0] = model.windows[0].workflows[0].jobs;
    expect(job0.durations).toBeNull();
    expect(job0.tally.completed).toBe(1);
  });

  it('leaves a cancelled job out of the durations, because a truncated job would drag the median down', () => {
    const passed = run();
    const cancelled = run({ conclusion: 'cancelled' });
    const model = build({
      runs: [passed, cancelled],
      jobs: [
        job({
          runId: passed.id,
          startedAt: '2026-09-06T12:00:00Z',
          completedAt: '2026-09-06T12:05:00Z',
        }),
        job({
          runId: cancelled.id,
          conclusion: 'cancelled',
          startedAt: '2026-09-06T12:00:00Z',
          completedAt: '2026-09-06T12:00:01Z',
        }),
      ],
      windows: [30],
    });
    expect(model.windows[0].workflows[0].jobs[0].durations).toEqual({
      median: 300_000,
      p90: 300_000,
      count: 1,
    });
  });

  it('lists a failure with the step it died on, linked to the run', () => {
    const failed = run({ conclusion: 'failure', headSha: 'deadbee' });
    const model = build({
      runs: [failed],
      jobs: [
        job({ runId: failed.id, name: 'E2E (F3)', conclusion: 'failure', failedStep: 'Run pnpm test:e2e' }),
        job({ runId: failed.id, name: 'Build' }),
      ],
    });
    expect(model.recentFailures).toHaveLength(1);
    expect(model.recentFailures[0].jobs).toEqual([
      {
        name: 'E2E (F3)',
        failedStep: 'Run pnpm test:e2e',
        url: 'https://github.com/o/r/actions/runs/1/job/1',
      },
    ]);
  });

  it('lists every failing job of one run, not just the first', () => {
    const failed = run({ conclusion: 'failure' });
    const model = build({
      runs: [failed],
      jobs: [
        job({ runId: failed.id, name: 'Test', conclusion: 'failure', failedStep: 'Run pnpm test' }),
        job({
          runId: failed.id,
          name: 'Test Explorer',
          conclusion: 'failure',
          failedStep: 'Run pnpm test:coverage',
        }),
      ],
    });
    expect(model.recentFailures[0].jobs.map((j) => j.name)).toEqual(['Test', 'Test Explorer']);
  });

  it('lists a failing job with no step recorded rather than inventing one', () => {
    const failed = run({ conclusion: 'failure' });
    const model = build({
      runs: [failed],
      jobs: [job({ runId: failed.id, name: 'E2E (F3)', conclusion: 'timed_out', failedStep: null })],
    });
    expect(model.recentFailures[0].jobs[0].failedStep).toBeNull();
  });

  it('surfaces a conclusion it does not recognise instead of quietly dropping it', () => {
    const model = build({ runs: [run({ conclusion: 'invented_next_year' })] });
    expect(model.anomalies).toHaveLength(1);
    expect(model.anomalies[0].detail).toContain('invented_next_year');
  });

  it('has no rate and no windows to report when nothing ran at all', () => {
    const model = build({ runs: [], jobs: [] });
    expect(model.coverage.oldestRun).toBeNull();
    expect(model.windows.every((w) => w.workflows.length === 0)).toBe(true);
    expect(model.redWindows).toEqual([]);
  });
});
