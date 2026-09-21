import { describe, expect, it } from 'vitest';

import { fitTo, partsOf, scaleFor } from '../../src/render/strips.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const BASE = Date.UTC(2026, 8, 15, 9, 0);
const at = (minutes) => new Date(BASE + minutes * MIN).toISOString();

/** A model pull request with rounds given as [pushed, ended] minutes past 09:00, merged at `merged`. */
const pull = (rounds, merged, beforeFirstPush = 0) => ({
  mergedAt: at(merged),
  beforeFirstPushMs: beforeFirstPush * MIN,
  rounds: rounds.map(([from, to]) => ({ pushedAt: at(from), endedAt: at(to), ms: (to - from) * MIN })),
});

describe('Lead time', () => {
  describe('a strip is cut to one shared scale and says so', () => {
    it('lays out coding, each round, the fixing between them and the wait to merge, in order', () => {
      const parts = partsOf(pull([[10, 20], [30, 40]], 45, 10));
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

    it('takes the longest strip as the scale, up to four hours, and never a scale of nothing', () => {
      expect(scaleFor([partsOf(pull([[0, 30]], 30)), partsOf(pull([[0, 90]], 90))])).toBe(90 * MIN);
      expect(scaleFor([partsOf(pull([[0, 6 * 60]], 6 * 60))])).toBe(4 * HOUR);
      expect(scaleFor([])).toBeGreaterThan(0);
    });

    it('leaves a strip that fits as it is, and says nothing was cut', () => {
      const parts = partsOf(pull([[0, 30]], 30));
      expect(fitTo(parts, 60 * MIN)).toMatchObject({ parts, shownMs: 30 * MIN, clipped: null });
    });

    it('cuts a strip at the scale and names how much it cut', () => {
      const fitted = fitTo(partsOf(pull([[0, 60], [70, 200]], 200)), 120 * MIN);
      expect(fitted.clipped).toEqual({ shownMs: 120 * MIN, totalMs: 200 * MIN });
      expect(fitted.parts.map((part) => [part.type, part.ms / MIN, Boolean(part.cut)])).toEqual([
        ['round', 60, false],
        ['fixing', 10, false],
        ['round', 50, true],
      ]);
    });

    it('draws no time away after the edge it was cut at, since it happened beyond it', () => {
      // A round fills the scale exactly, then the pull request goes away for a night.
      const fitted = fitTo(partsOf(pull([[0, 60], [600, 660]], 660)), 60 * MIN);
      expect(fitted.parts.map((part) => part.type)).toEqual(['round']);
      expect(fitted.clipped).toEqual({ shownMs: 60 * MIN, totalMs: 120 * MIN });
    });

    it('keeps time away that comes before the edge, and leaves it off the scale', () => {
      const fitted = fitTo(partsOf(pull([[0, 30], [400, 430]], 430)), 60 * MIN);
      expect(fitted.parts.map((part) => part.type)).toEqual(['round', 'away', 'round']);
      expect(fitted.clipped).toBeNull();
      expect(fitted.shownMs).toBe(60 * MIN);
    });
  });
});
