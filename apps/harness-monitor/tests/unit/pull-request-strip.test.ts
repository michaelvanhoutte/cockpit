import { describe, expect, it } from 'vitest';
import type { CycleTimeline, ReviewSlice, RunSlice, TimelineLane } from '../../src/cycle-time';
import type { CycleTimePull } from '../../src/cycle-time-store';
import { axisFor, fitTo, partsOf, placeLanes, scaleFor, stripOf, type StripPull, type StripRound } from '../../src/pull-request-strip';

const MIN = 60_000;
const HOUR = 60 * MIN;
const BASE = Date.UTC(2026, 8, 15, 9, 0);
const at = (minutes: number) => new Date(BASE + minutes * MIN).toISOString();

/** A pull request with rounds given as [pushed, ended] minutes past 09:00, merged at `merged`, and the local work its timeline holds. */
const pull = (rounds: [number, number][], merged: number, { before = 0, reviews = [], runs = [] }: { before?: number; reviews?: ReviewSlice[]; runs?: RunSlice[] } = {}): StripPull => ({
  number: 1,
  recorded: true,
  beforeFirstPushMs: before * MIN,
  mergedAt: at(merged),
  totalMs: merged * MIN,
  rounds: rounds.map(([from, to]): StripRound => ({ pushedAt: at(from), endedAt: at(to), ms: (to - from) * MIN, red: false, failed: [], flukes: [], held: [], lanes: null })),
  reviewSlices: reviews,
  runSlices: runs,
  notes: [],
});

/** A local slice from `from` to `to` minutes past 09:00, in the gap after round `gap`. */
const review = (kind: ReviewSlice['kind'], from: number, to: number, gap = 0): ReviewSlice => ({ kind, level: 'high', gap, at: at(from), ms: (to - from) * MIN });
const run = (kind: RunSlice['kind'], from: number, to: number, gap = 0): RunSlice => ({ kind, gap, at: at(from), ms: (to - from) * MIN });

/** The one stretch of parallel local work, as each lane's kind and row. */
const rowsOf = (strip: StripPull) =>
  (partsOf(strip).find((part) => part.type === 'parallel')?.lanes as { kind: string; row: number }[]).map((lane) => [lane.kind, lane.row]);
const parallel = (strip: StripPull) => partsOf(strip).find((part) => part.type === 'parallel');

describe('Harness Monitor', () => {
  describe("a pull request's strip draws every part at its own time and length", () => {
    it('lays out coding, each round, the fixing between them and the wait to merge, in order', () => {
      const parts = partsOf(pull([[10, 20], [30, 40]], 45, { before: 10 }));

      expect(parts.map((part) => [part.type, part.ms / MIN])).toEqual([
        ['coding', 10],
        ['round', 10],
        ['fixing', 10],
        ['round', 10],
        ['wait', 5],
      ]);
    });

    it('lays out nothing for a pull request no check ran on', () => {
      expect(partsOf(pull([], 45))).toEqual([]);
    });

    it('draws a gap of over three hours as time away, off the scale, and starts what follows at its own time from the break', () => {
      const fitted = fitTo(partsOf(pull([[0, 30], [400, 430]], 430)), 90 * MIN);

      expect(fitted.parts.map((part) => [part.type, part.startMs / MIN, part.breaksBefore])).toEqual([
        ['round', 0, 0],
        ['away', 30, 0],
        ['round', 30, 1],
      ]);
      expect(fitted.breaks).toBe(1);
      expect(fitted.shownMs).toBe(60 * MIN);
    });

    it('keeps a slice too short to see at its own length, so what follows still starts at its own time', () => {
      // Fifteen seconds of review five minutes in. The page draws it 3px wide; here it is not widened, so the round after it is where its time puts it.
      const fitted = fitTo(partsOf(pull([[20, 40]], 40, { before: 20, reviews: [{ kind: 'code-review', gap: 0, at: at(5), ms: 15_000 }] })), 60 * MIN);

      const slice = fitted.parts.find((part) => part.type === 'review')!;
      expect([slice.startMs, slice.ms]).toEqual([5 * MIN, 15_000]);
      expect(fitted.parts.find((part) => part.type === 'round')!.startMs).toBe(20 * MIN);
    });

    it('starts every part where the one before it ends, with no gap added, however many local slices sit between', () => {
      const strip = pull([[20, 40]], 40, { before: 20, reviews: [review('code-review', 2, 6), review('security-review', 8, 10)] });

      const fitted = fitTo(partsOf(strip), 40 * MIN);

      let end = 0;
      for (const part of fitted.parts) {
        expect(part.startMs).toBe(end);
        end += part.ms;
      }
      expect(end).toBe(fitted.shownMs);
    });

    it('cuts a local slice out of the coding or fixing it sat in, so the strip adds up to the same minutes', () => {
      const parts = partsOf(pull([[20, 40], [55, 65]], 70, { before: 20, reviews: [review('security-review', 42, 50, 1)], runs: [run('test', 5, 9)] }));

      expect(parts.map((part) => [part.type, part.kind ?? null, part.ms / MIN])).toEqual([
        ['coding', null, 5],
        ['test', 'test', 4],
        ['coding', null, 11],
        ['round', null, 20],
        ['fixing', null, 2],
        ['review', 'security-review', 8],
        ['fixing', null, 5],
        ['round', null, 10],
        ['wait', null, 5],
      ]);
    });

    it('draws a gap of over three hours as away in place of the fixing, with no local work cut out of it', () => {
      const parts = partsOf(pull([[20, 40], [300, 310]], 420, { before: 20, reviews: [review('code-review', 100, 120, 1)] }));

      expect(parts.map((part) => part.type)).toEqual(['coding', 'round', 'away', 'round', 'wait']);
    });
  });

  describe("a strip is cut to its scale and says how much it cut", () => {
    it('takes the strip length as the scale, up to four hours, and never a scale of nothing', () => {
      expect(scaleFor([partsOf(pull([[0, 90]], 90))])).toBe(90 * MIN);
      expect(scaleFor([partsOf(pull([[0, 6 * 60]], 6 * 60))])).toBe(4 * HOUR);
      expect(scaleFor([[]])).toBeGreaterThan(0);
    });

    it('leaves a strip that fits as it is, and says nothing was cut', () => {
      const parts = partsOf(pull([[0, 30]], 30));

      expect(fitTo(parts, 60 * MIN)).toMatchObject({ shownMs: 30 * MIN, clipped: null });
    });

    it('cuts a strip longer than the scale at its edge and names how much it cut', () => {
      const fitted = fitTo(partsOf(pull([[0, 60], [70, 200]], 200)), 120 * MIN);

      expect(fitted.clipped).toEqual({ shownMs: 120 * MIN, totalMs: 200 * MIN });
      expect(fitted.parts.map((part) => [part.type, part.ms / MIN, Boolean(part.cut)])).toEqual([
        ['round', 60, false],
        ['fixing', 10, false],
        ['round', 50, true],
      ]);
    });

    it('draws no time away after the edge it was cut at, since it happened beyond it', () => {
      const fitted = fitTo(partsOf(pull([[0, 60], [600, 660]], 660)), 60 * MIN);

      expect(fitted.parts.map((part) => part.type)).toEqual(['round']);
      expect(fitted.clipped).toEqual({ shownMs: 60 * MIN, totalMs: 120 * MIN });
    });

    it('keeps time away that comes before the edge, and leaves it off the scale', () => {
      const fitted = fitTo(partsOf(pull([[0, 30], [400, 470]], 470)), 60 * MIN);

      expect(fitted.parts.map((part) => [part.type, part.ms / MIN])).toEqual([
        ['round', 30],
        ['away', 370],
        ['round', 30],
      ]);
      expect(fitted.clipped).toEqual({ shownMs: 60 * MIN, totalMs: 100 * MIN });
    });
  });

  describe('a zoomed strip has a clock-time axis from its start to its merge', () => {
    const clock = (minutes: number) => BASE + minutes * MIN;

    it('puts a tick at the pull request’s start and at its merge, and round clock times between, leaving out the one a label’s width from the merge', () => {
      const ticks = axisFor(clock(0), fitTo(partsOf(pull([[10, 20], [30, 40]], 45, { before: 10 })), Infinity));

      expect(ticks.map((tick) => [tick.atMs, tick.startMs / MIN])).toEqual([[clock(0), 0], [clock(10), 10], [clock(20), 20], [clock(30), 30], [clock(45), 45]]);
      expect([ticks[0]!.align, ticks[ticks.length - 1]!.align]).toEqual(['start', 'end']);
    });

    it('reads the real clock time either side of time away, with nothing inside it', () => {
      const ticks = axisFor(clock(0), fitTo(partsOf(pull([[0, 30], [400, 430]], 430)), Infinity));

      expect(ticks.filter((tick) => tick.atMs > clock(30) && tick.atMs < clock(400))).toEqual([]);
      expect(ticks.filter((tick) => [clock(30), clock(400)].includes(tick.atMs)).map((tick) => [tick.atMs, tick.breaksBefore, tick.align])).toEqual([
        [clock(30), 0, 'end'],
        [clock(400), 1, 'start'],
      ]);
      expect(ticks[ticks.length - 1]!.atMs).toBe(clock(430));
    });

    it('leaves out the clock picking up after time away where the merge follows close behind, so its label stays on the axis', () => {
      const ticks = axisFor(clock(0), fitTo(partsOf(pull([[0, 300], [700, 701]], 702)), Infinity));

      expect(ticks.filter((tick) => tick.breaksBefore === 1).map((tick) => [tick.atMs, tick.align])).toEqual([[clock(702), 'end']]);
    });

    it('puts the ticks between on round Belgian clock times, which a step of several hours tells from round Greenwich ones', () => {
      // 24 hours from 13:05 UTC (15:05 in Brussels) is drawn in three-hour steps where the labels fit, and in six-hour ones where they do not.
      // Brussels' midnight is 22:00 UTC; Greenwich's, three hours of a step away from every Brussels one, would be 00:00 UTC.
      const start = Date.parse('2026-10-22T13:05:00Z');

      const between = axisFor(start, fitTo(partsOf(pull([[0, 24 * 60]], 24 * 60)), Infinity)).filter((tick) => tick.align === 'mid');

      expect(between.map((tick) => new Date(tick.atMs).toISOString())).toEqual(['2026-10-22T22:00:00.000Z']);
      expect(between[0]!.label).toBe('23 Oct 00:00');
    });

    describe('every label has room, whatever time of day the pull request ran', () => {
      // 30 minutes of coding, a round of 5, then 9 hours away to the merge: the strip ends in a break, and the merge falls on a later day than the start for some start times.
      const awayAtTheEnd = pull([[30, 35]], 35 + 9 * 60, { before: 30 });

      it('puts one tick, the end’s, where a break ends the strip, and none hanging past it', () => {
        const zoomed = fitTo(partsOf(awayAtTheEnd), Infinity);

        for (let minute = 0; minute < 24 * 60; minute += 15) {
          const ticks = axisFor(BASE + minute * MIN, zoomed);

          const last = ticks[ticks.length - 1]!;
          expect(last.atMs).toBe(BASE + minute * MIN + (35 + 9 * 60) * MIN);
          expect(last.align).toBe('end');
          expect(ticks.filter((tick) => tick.startMs === zoomed.shownMs && tick.breaksBefore === 1)).toEqual([last]);
          expect(ticks.filter((tick) => tick.align === 'start' && tick.breaksBefore === 1)).toEqual([]);
        }
      });

      it('dates a label only on a later day than the start’s, and takes a wider step where the dates made the labels too wide to sit together', () => {
        // From 20:00 in Brussels, 12 hours: 21:00 to 23:00 are on the start's day, so their labels are short; midnight and after carry the date.
        const overnight = fitTo(partsOf(pull([[0, 12 * 60]], 12 * 60)), Infinity);

        const ticks = axisFor(Date.UTC(2026, 8, 15, 18, 0), overnight);

        expect(ticks.map((tick) => tick.label)).toEqual(['20:00', '16 Sept 00:00', '16 Sept 08:00']);
      });
    });

    it('draws a strip of weeks in day steps, not minute ones', () => {
      const ticks = axisFor(BASE, fitTo(partsOf(pull([[0, 20 * 24 * 60]], 20 * 24 * 60)), Infinity));

      expect(ticks.length).toBeLessThan(30);
    });

    it('covers the whole pull request, though the closed strip was cut', () => {
      const parts = partsOf(pull([[0, 60], [70, 200]], 200));

      expect(fitTo(parts, 120 * MIN).clipped).not.toBeNull();
      const zoomed = fitTo(parts, Infinity);
      expect(zoomed.clipped).toBeNull();
      expect(axisFor(clock(0), zoomed).pop()!.atMs).toBe(clock(200));
    });
  });

  describe("a round's jobs sit in rows by when they ran", () => {
    const lane = (name: string, from: number, to: number, lead = 0): TimelineLane =>
      ({ name, offsetMs: from * MIN, ms: (to - from) * MIN, leadMs: lead * MIN }) as TimelineLane;
    const jobRows = (...lanes: TimelineLane[]) => Object.fromEntries(placeLanes(lanes)!.map((each) => [each.name, each.row]));

    it('puts jobs that ran together in different rows and a job that began where another ended in its row', () => {
      const rows = jobRows(lane('Checks', 0, 3), lane('Test', 0, 9), lane('Publish', 9, 12, 0));

      expect(rows.Checks).not.toBe(rows.Test);
      expect(rows.Publish).toBe(rows.Test);
    });

    it('keeps a job that waited for a runner in the row of what it waited behind only where its lead begins after that one ended', () => {
      // Test is created at minute 3 and starts at 5: its lead is in Checks' row only because Checks ended at 3.
      const behind = jobRows(lane('Checks', 0, 3), lane('Test', 5, 9, 2));
      expect(behind.Test).toBe(behind.Checks);
      // Created at minute 2, its lead overlaps Checks, so it needs a row of its own.
      const overlapping = jobRows(lane('Checks', 0, 3), lane('Test', 4, 9, 2));
      expect(overlapping.Test).not.toBe(overlapping.Checks);
    });

    it('holds the strip’s line with the row that was busiest, then stacks the rest above and below it', () => {
      const rows = jobRows(lane('Checks', 0, 3), lane('E2E', 0, 25), lane('Test', 0, 9));

      expect(rows.E2E).toBe(0);
      expect(new Set(Object.values(rows))).toEqual(new Set([0, -1, 1]));
    });

    it('places nothing for a round whose jobs are not recorded', () => {
      expect(placeLanes(null)).toBeNull();
      expect(placeLanes(undefined)).toBeNull();
    });
  });

  describe('local work that overlaps takes as few rows as ever run at once', () => {
    it('packs a 25-minute browser pass with 27 short test runs beside it, one at a time, into 2 rows with the browser pass on the line', () => {
      // 27 runs of 40 seconds, each starting as the one before ends, during a 25-minute browser pass.
      const runs = Array.from({ length: 27 }, (_, i): RunSlice => ({ kind: 'test', gap: 0, at: at(1 + (i * 2) / 3), ms: 40_000 }));
      const strip = pull([[30, 50]], 50, { before: 30, runs: [...runs, run('browser', 1, 26)] });

      const lanes = parallel(strip)!.lanes as { kind: string; row: number }[];

      expect(lanes).toHaveLength(28);
      expect(new Set(lanes.map((lane) => lane.row)).size).toBe(2);
      expect(lanes.find((lane) => lane.kind === 'browser')!.row).toBe(0);
      expect(lanes.filter((lane) => lane.kind === 'test').every((lane) => lane.row === -1)).toBe(true);
    });

    it('takes a row for each of three slices running at once', () => {
      const strip = pull([[30, 50]], 50, { before: 30, reviews: [review('code-review', 2, 12), review('security-review', 3, 11)], runs: [run('test', 4, 10)] });

      expect(rowsOf(strip)).toEqual([['code-review', 0], ['security-review', -1], ['test', 1]]);
    });

    it('gives a fourth slice running at once a further row, above again', () => {
      const strip = pull([[30, 50]], 50, { before: 30, reviews: [review('code-review', 2, 12), review('security-review', 3, 11)], runs: [run('test', 4, 10), run('browser', 5, 9)] });

      expect(rowsOf(strip)).toEqual([['code-review', 0], ['security-review', -1], ['test', 1], ['browser', -2]]);
    });

    it('draws two slices where one began as the other ended as two parts in sequence, never stacked', () => {
      const parts = partsOf(pull([[30, 50]], 50, { before: 30, reviews: [review('code-review', 2, 8)], runs: [run('test', 8, 14)] }));

      expect(parts.map((part) => part.type)).toEqual(['coding', 'review', 'test', 'coding', 'round']);
    });

    it('lets a slice that began as another ended carry on its row while a third still runs beside them', () => {
      // The review runs 0-10 and the browser pass 5-15, so they are one stretch; the test run begins as the review ends, and takes its row.
      const strip = pull([[30, 50]], 50, { before: 30, reviews: [review('code-review', 2, 12)], runs: [run('browser', 7, 17), run('test', 12, 15)] });

      const lanes = parallel(strip)!.lanes as { kind: string; row: number }[];

      expect(new Set(lanes.map((lane) => lane.row)).size).toBe(2);
      expect(lanes.find((lane) => lane.kind === 'test')!.row).toBe(lanes.find((lane) => lane.kind === 'code-review')!.row);
    });

    it('keeps the same one of two equally busy rows on the line on every render, whichever slice was recorded first', () => {
      const first = pull([[30, 50]], 50, { before: 30, reviews: [review('code-review', 2, 8), review('security-review', 2, 8)] });
      const reversed = pull([[30, 50]], 50, { before: 30, reviews: [review('security-review', 2, 8), review('code-review', 2, 8)] });

      expect(rowsOf(first)).toEqual([['code-review', 0], ['security-review', -1]]);
      expect(rowsOf(reversed)).toEqual(rowsOf(first));
    });

    it('shows the coding or fixing on the line where no lane of the stretch runs on it', () => {
      const coding = parallel(pull([[30, 50]], 50, { before: 30, reviews: [review('code-review', 2, 10)], runs: [run('test', 8, 14)] }))!;
      expect(coding).toMatchObject({ base: 'coding', ms: 12 * MIN });
      const line = (coding.lanes as { offsetMs: number; ms: number; row: number }[]).find((lane) => lane.row === 0)!;
      expect(line.offsetMs + line.ms).toBeLessThan(coding.ms);

      const fixing = parallel(pull([[10, 20], [55, 65]], 70, { before: 10, reviews: [review('code-review', 22, 30, 1)], runs: [run('test', 28, 33, 1)] }));
      expect(fixing!.base).toBe('fixing');
    });

    it('names the whole length of a lane on it, not only the part inside the gap it was cut to', () => {
      // The browser pass runs 25-45 and the first push is at 40: the lane is 15 minutes of the strip, and says it ran for 20.
      const strip = pull([[40, 60]], 60, { before: 40, reviews: [review('code-review', 5, 30)], runs: [run('browser', 25, 45)] });

      const lanes = parallel(strip)!.lanes as { kind: string; ms: number; sliceMs: number }[];

      expect(lanes.find((lane) => lane.kind === 'browser')).toMatchObject({ ms: 15 * MIN, sliceMs: 20 * MIN });
    });
  });

  describe('a stored pull request and its timeline become the strip the static page draws', () => {
    const timeline = (lanes: (TimelineLane[] | null)[]): CycleTimeline => ({ lanes, reviewSlices: [], runSlices: [] });
    const check = (name: string, heldMs: number, over: Record<string, unknown> = {}) => ({ name, attempt: 1, heldMs, last: false, failure: null, flukeMs: null, queuedMs: null, runningMs: null, failedSteps: [], failedFiles: [], ...over });
    const stored = (over: Record<string, unknown> = {}): CycleTimePull =>
      ({
        number: 9,
        mergedAt: at(70),
        recorded: true,
        start: { at: at(5), from: 'session-record' },
        time: { totalMs: 65 * MIN },
        rounds: [
          { pushedAt: at(20), endedAt: at(40), ms: 20 * MIN, red: true, failed: ['Test'], checks: [check('Test', 10 * MIN, { failure: 'fluke', flukeMs: 2 * MIN }), check('Test', 6 * MIN, { attempt: 2 }), check('Lint', 4 * MIN)] },
        ],
        ...over,
      }) as unknown as CycleTimePull;

    it('says what held each round in order, marks a repeated check as a re-run, and carries its fluke and failures', () => {
      const [round] = stripOf(stored(), timeline([null])).rounds;

      expect(round!.held).toEqual([{ name: 'Test', ms: 10 * MIN }, { name: 'Test', ms: 6 * MIN, rerun: true }, { name: 'Lint', ms: 4 * MIN }]);
      expect(round!.flukes).toEqual([{ name: 'Test', ms: 2 * MIN }]);
      expect([round!.red, round!.failed]).toEqual([true, ['Test']]);
    });

    it('reads a round with an empty list of jobs as one whose jobs were not recorded', () => {
      expect(stripOf(stored(), timeline([[]])).rounds[0]!.lanes).toBeNull();
    });

    it('starts the coding at the stored start, and notes a pull request with no session record', () => {
      expect(stripOf(stored(), timeline([null])).beforeFirstPushMs).toBe(15 * MIN);
      const unrecorded = stripOf(stored({ recorded: false }), timeline([null]));
      expect(unrecorded.notes).toEqual([expect.stringContaining('No session record')]);
    });
  });
});
