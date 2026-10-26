import { describe, expect, it } from 'vitest';
import { humanMs, pct } from '../../src/report';
import { parseStabilityQuery, sortJobs, stabilityAddress, tallyOf, type Tally } from '../../src/stability-report';

describe('Harness Monitor', () => {
  describe("a job's pass rate counts its passed runs against its passed and failed runs, with cancelled and skipped runs apart", () => {
    it.each([
      { situation: '8 passed, 2 failed, 3 cancelled, 1 skipped', counts: { pass: 8, fail: 2, cancelled: 3, skipped: 1 }, rate: 0.8, cancelled: 3 },
      { situation: 'only cancelled runs', counts: { cancelled: 4 }, rate: null, cancelled: 4 },
      { situation: 'a run still going and one with a verdict nobody knows', counts: { pass: 1, running: 2, unknown: 1 }, rate: 1, cancelled: 0 },
    ])('$situation', ({ counts, rate, cancelled }) => {
      const t = tallyOf(counts);
      expect(t.rate).toBe(rate);
      expect(t.cancelled).toBe(cancelled);
    });

    it('never reads a rate better than it is', () => {
      expect(pct(tallyOf({ pass: 2_999, fail: 1 }).rate!)).toBe('99.9%');
      expect(pct(tallyOf({ pass: 3 }).rate!)).toBe('100%');
    });
  });

  describe('sort by orders each tab as named', () => {
    const tally = (pass: number, fail: number): Tally => tallyOf({ pass, fail });
    const job = (name: string, t: Tally, median: number | null, branchFlaky = 0) => ({ name, branchFlaky, job: { tally: t, durations: median === null ? null : { median } } });
    const jobs = [job('steady', tally(10, 0), 60_000), job('flaky', tally(7, 3), 30_000), job('slow', tally(9, 1), 600_000), job('new', tally(0, 0), null)];

    it.each([
      { situation: 'jobs by least reliable, a job with no verdict last', sort: 'worst', expected: ['flaky', 'slow', 'steady', 'new'] },
      { situation: 'jobs by slowest, a job with no time last', sort: 'slowest', expected: ['slow', 'steady', 'flaky', 'new'] },
      { situation: 'jobs by most failures', sort: 'failures', expected: ['flaky', 'slow', 'steady', 'new'] },
    ])('$situation', ({ sort, expected }) => {
      expect(sortJobs(jobs, sort).map((j) => j.name)).toEqual(expected);
    });

    it('a job with the same failures on main as another is ranked above it for flaking on more feature branches', () => {
      const tied = [job('quiet', tally(9, 1), 1_000), job('flaky on branches', tally(9, 1), 1_000, 4), job('new on branches', tally(0, 0), null, 2)];

      expect(sortJobs(tied, 'failures').map((j) => j.name)).toEqual(['flaky on branches', 'quiet', 'new on branches']);
      expect(sortJobs(tied, 'worst').map((j) => j.name)).toEqual(['flaky on branches', 'quiet', 'new on branches']);
    });
  });

  describe('a view has one address, and its defaults are not in it', () => {
    it('reads the address into the view and writes the same view back', () => {
      const q = parseStabilityQuery(new URLSearchParams('period=30d&workflow=CI&group=job&sort=slowest&steps=CI%7CTest'));

      expect(q).toEqual({ period: '30d', workflow: 'CI', group: 'job', sort: 'slowest', steps: 'CI|Test' });
      expect(stabilityAddress(q)).toBe('/stability?period=30d&workflow=CI&sort=slowest&steps=CI%7CTest');
    });

    it.each([
      { situation: 'an unknown period, tab and order', address: 'period=2y&group=nope&sort=sideways', expected: '/stability' },
      { situation: "a tab's default order", address: 'group=workflow&sort=worst', expected: '/stability?group=workflow' },
      { situation: 'an order the tab does not have', address: 'group=workflow&sort=slowest', expected: '/stability?group=workflow' },
      { situation: 'a job opened on a tab that has no jobs', address: 'group=workflow&steps=CI%7CTest', expected: '/stability?group=workflow' },
    ])('$situation falls back', ({ address, expected }) => {
      expect(stabilityAddress(parseStabilityQuery(new URLSearchParams(address)))).toBe(expected);
    });
  });

  describe('the addresses of the tabs that became the Workflow tab still open it', () => {
    it.each([
      { situation: 'Red spells', address: 'group=red', expected: '/stability?group=workflow' },
      { situation: 'Failures', address: 'group=failures&period=30d', expected: '/stability?period=30d&group=workflow' },
      { situation: 'Over time with a Workflow filter', address: 'group=day&workflow=CI', expected: '/stability?workflow=CI&group=workflow' },
      { situation: "Red spells' order, which Workflow does not offer", address: 'group=red&sort=longest', expected: '/stability?group=workflow' },
    ])('$situation', ({ address, expected }) => {
      expect(stabilityAddress(parseStabilityQuery(new URLSearchParams(address)))).toBe(expected);
    });

    it('keeps the Workflow filter on the Workflow tab, which names the workflow whose own view it opens', () => {
      expect(stabilityAddress(parseStabilityQuery(new URLSearchParams('group=workflow&workflow=CI&sort=failures')))).toBe('/stability?workflow=CI&group=workflow&sort=failures');
    });
  });

  describe('a duration reads as the report reads it', () => {
    it.each([
      { ms: 0, text: '0s' },
      { ms: 9_400, text: '9s' },
      { ms: 564_000, text: '9m 24s' },
      { ms: 23_000_000 - 20_000, text: '6h 23m' },
      { ms: null, text: '—' },
    ])('$text', ({ ms, text }) => {
      expect(humanMs(ms)).toBe(text);
    });
  });
});
