import { describe, expect, it } from 'vitest';

import { buildModel } from '../../src/model.js';
import { renderHtml } from '../../src/render/html.js';

const NOW = new Date('2026-09-07T12:00:00Z');
const ago = (days) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

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

const render = ({ runs = [], jobs = [], ...rest } = {}) =>
  renderHtml(
    buildModel({
      runs,
      jobs,
      now: NOW,
      requestedDays: 30,
      truncated: false,
      repo: 'o/r',
      ...rest,
    }),
  );

describe('renderHtml', () => {
  it('puts the counts beside every percentage, so a rate over two runs cannot pass for one over two hundred', () => {
    const passed = run();
    const failed = run({ conclusion: 'failure' });
    const html = render({
      runs: [passed, failed],
      jobs: [job({ runId: passed.id }), job({ runId: failed.id, conclusion: 'failure' })],
    });
    expect(html).toContain('50%');
    expect(html).toContain('1/2');
  });

  it('says "no data" for a job nothing has finished, rather than drawing it as a zero', () => {
    const cancelled = run({ conclusion: 'cancelled' });
    const html = render({
      runs: [cancelled],
      jobs: [job({ runId: cancelled.id, conclusion: 'cancelled' })],
    });
    expect(html).toContain('no data');
    expect(html).not.toContain('>0%<');
  });

  it('names what a rate left out instead of only subtracting it', () => {
    const cancelled = run({ conclusion: 'cancelled' });
    const passed = run();
    const html = render({
      runs: [cancelled, passed],
      jobs: [job({ runId: cancelled.id, conclusion: 'cancelled' }), job({ runId: passed.id })],
    });
    expect(html).toContain('1 cancelled');
  });

  it('warns on its own page when it covers less than it was asked for', () => {
    const html = render({ runs: [run({ createdAt: ago(9) })], requestedDays: 30 });
    expect(html).toContain('This covers 9 days, not 30');
  });

  it('says in the column heading itself that a window is shorter than its name', () => {
    const html = render({ runs: [run({ createdAt: ago(9) })], requestedDays: 30 });
    expect(html).toContain('30 days (only 9 available)');
  });

  it('surfaces a conclusion it does not recognise on the page, not only in the model', () => {
    const html = render({ runs: [run({ conclusion: 'invented_next_year' })] });
    expect(html).toContain('does not know how to count');
  });

  it('links to the test explorer, which is the page it is published beside', () => {
    const html = render({ runs: [run()] });
    expect(html).toContain('href="../"');
    expect(html).toContain('Test explorer');
  });

  it('escapes a job name rather than letting it write markup into the page', () => {
    const failed = run({ conclusion: 'failure' });
    const html = render({
      runs: [failed],
      jobs: [job({ runId: failed.id, name: '<script>alert(1)</script>', conclusion: 'failure' })],
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('says the branch has not been red when it has not, rather than showing an empty box', () => {
    const html = render({ runs: [run()] });
    expect(html).toContain('has not been red in this window');
  });

  it('takes durations from the widest window however the windows were ordered', () => {
    // `--windows 30,7` is ordered as given, so picking by position rather than
    // by days would quietly report the narrower sample.
    const old = run({ createdAt: ago(20) });
    const recent = run({ createdAt: ago(1) });
    const jobs = [
      job({ runId: old.id, startedAt: '2026-08-18T12:00:00Z', completedAt: '2026-08-18T12:10:00Z' }),
      job({
        runId: recent.id,
        startedAt: '2026-09-06T12:00:00Z',
        completedAt: '2026-09-06T12:01:00Z',
      }),
    ];
    // 30 days holds both runs, so its median is 5m30s; 7 days holds only the
    // one-minute run.
    const descending = render({ runs: [old, recent], jobs, windows: [30, 7] });
    const ascending = render({ runs: [old, recent], jobs, windows: [7, 30] });
    expect(descending).toContain('5m 30s');
    expect(ascending).toContain('5m 30s');
  });

  it('names the window its exclusions column belongs to, since two rate columns sit beside it', () => {
    const html = render({ runs: [run()], windows: [7, 30] });
    expect(html).toContain('Left out of 7 days');
  });

  it('never prints 100% for a rate that is not 100%', () => {
    // 999 passes and one failure rounds to 100.0 at one decimal; the page must
    // keep 100% for a job that really has not failed.
    const runs = [
      ...Array.from({ length: 999 }, () => run()),
      run({ conclusion: 'failure' }),
    ];
    const html = render({ runs });
    expect(html).toContain('99.9%');
    expect(html).not.toContain('>100%<');
  });

  it('marks its timestamps as UTC everywhere, not only in the masthead', () => {
    const failed = run({ conclusion: 'failure', createdAt: ago(2) });
    const passed = run({ createdAt: ago(1) });
    const html = render({
      runs: [failed, passed],
      jobs: [job({ runId: failed.id, conclusion: 'failure' })],
    });
    // Both the red stretch and the failure list carry the marker.
    expect(html.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?!Z)/)).toBeNull();
  });

  it('says which period the red stretches cover, since it is not the table\'s windows', () => {
    const html = render({ runs: [run({ createdAt: ago(9) })] });
    expect(html).toContain('Over all 9 days read, not the windows above');
  });
});
