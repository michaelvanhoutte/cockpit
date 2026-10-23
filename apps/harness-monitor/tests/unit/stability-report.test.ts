import { describe, expect, it } from 'vitest';
import { humanMs, pct } from '../../src/report';
import {
  parseStabilityQuery,
  redMs,
  redSpells,
  sortJobs,
  sortSpells,
  sortWorkflows,
  stabilityAddress,
  tallyOf,
  type FinishedRun,
  type Spell,
  type Tally,
} from '../../src/stability-report';

const HOUR = 3_600_000;
const at = (time: string) => Date.parse(`2026-10-20T${time}:00Z`);

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

  describe('time main was red counts overlapping red spells across workflows once, and a spell still open runs to now', () => {
    const run = (id: number, workflow: string, outcome: 'pass' | 'fail', time: string, headSha = 'a'): FinishedRun => ({ id, workflow, outcome, createdAt: at(time), url: `https://github.com/o/r/actions/runs/${id}`, headSha });

    it('CI red 10:00-12:00 and Nightly red 11:00-13:00 is 3 hours red', () => {
      const spells = redSpells([run(1, 'CI', 'fail', '10:00'), run(2, 'CI', 'pass', '12:00'), run(3, 'Nightly', 'fail', '11:00'), run(4, 'Nightly', 'pass', '13:00')]);

      expect(spells.map((s) => [s.workflow, s.ongoing])).toEqual([
        ['Nightly', false],
        ['CI', false],
      ]);
      expect(redMs(spells, at('00:00'), at('23:00'))).toBe(3 * HOUR);
    });

    it('a spell with no green run after it runs to now and is marked open', () => {
      const spells = redSpells([run(1, 'CI', 'fail', '10:00'), run(2, 'CI', 'fail', '10:30', 'b')]);

      expect(spells).toHaveLength(1);
      expect(spells[0]).toMatchObject({ ongoing: true, until: null, commits: 2 });
      expect(redMs(spells, at('00:00'), at('14:00'))).toBe(4 * HOUR);
    });

    it('counts only the part of a spell inside the period', () => {
      const spells = redSpells([run(1, 'CI', 'fail', '10:00'), run(2, 'CI', 'pass', '14:00')]);

      expect(redMs(spells, at('12:00'), at('23:00'))).toBe(2 * HOUR);
    });
  });

  describe('sort by orders each tab as named', () => {
    const tally = (pass: number, fail: number): Tally => tallyOf({ pass, fail });
    const job = (name: string, t: Tally, median: number | null) => ({ name, job: { tally: t, durations: median === null ? null : { median } } });
    const jobs = [job('steady', tally(10, 0), 60_000), job('flaky', tally(7, 3), 30_000), job('slow', tally(9, 1), 600_000), job('new', tally(0, 0), null)];

    it.each([
      { situation: 'jobs by least reliable, a job with no verdict last', sort: 'worst', expected: ['flaky', 'slow', 'steady', 'new'] },
      { situation: 'jobs by slowest, a job with no time last', sort: 'slowest', expected: ['slow', 'steady', 'flaky', 'new'] },
      { situation: 'jobs by most failures', sort: 'failures', expected: ['flaky', 'slow', 'steady', 'new'] },
    ])('$situation', ({ sort, expected }) => {
      expect(sortJobs(jobs, sort).map((j) => j.name)).toEqual(expected);
    });

    it.each([
      { situation: 'workflows by least reliable', sort: 'worst', expected: ['B', 'A', 'C'] },
      { situation: 'workflows by longest red', sort: 'red', expected: ['A', 'B', 'C'] },
      { situation: 'workflows by most failures', sort: 'failures', expected: ['B', 'A', 'C'] },
    ])('$situation, one that never finished last', ({ sort, expected }) => {
      const rows = [
        { name: 'A', tally: tally(9, 1), red: 5 * HOUR },
        { name: 'B', tally: tally(5, 5), red: HOUR },
        { name: 'C', tally: tally(0, 0), red: 0 },
      ];
      expect(sortWorkflows(rows, sort).map((r) => r.name)).toEqual(expected);
    });

    it.each([
      { situation: 'red spells newest first', sort: 'newest', expected: ['second', 'first'] },
      { situation: 'red spells longest first', sort: 'longest', expected: ['first', 'second'] },
    ])('$situation', ({ sort, expected }) => {
      const spell = (workflow: string, from: number, until: number | null): Spell => ({ workflow, from, fromUrl: '', until, untilUrl: null, ongoing: until === null, commits: 1, openedBy: 1 });
      expect(sortSpells([spell('first', at('01:00'), at('09:00')), spell('second', at('10:00'), at('11:00'))], sort, at('20:00')).map((s) => s.workflow)).toEqual(expected);
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
      { situation: "a tab's default order", address: 'group=red&sort=newest', expected: '/stability?group=red' },
      { situation: 'an order the tab does not have', address: 'group=failures&sort=slowest', expected: '/stability?group=failures' },
      { situation: 'a job opened on a tab that has no jobs', address: 'group=day&steps=CI%7CTest', expected: '/stability?group=day' },
    ])('$situation falls back', ({ address, expected }) => {
      expect(stabilityAddress(parseStabilityQuery(new URLSearchParams(address)))).toBe(expected);
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
