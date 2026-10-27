import { describe, expect, it } from 'vitest';

import { main, output, parseArgs } from '../../src/cli.js';
import { buildModel } from '../../src/model.js';

describe('Cycle time', () => {
  describe('the command line refuses what would silently widen the fetch', () => {
    it('reports over 7 and 14 days when told nothing', () => {
      const args = parseArgs([]);
      expect(args.windows).toEqual([7, 14]);
      expect(args.days).toBeUndefined();
      expect(args.invalid).toBeUndefined();
    });

    it('refuses a pull budget that is not a number, rather than reading it as no budget', () => {
      // Number('1SO') is NaN and every comparison against NaN is false, so an
      // unchecked typo would not shrink the budget but remove it.
      const args = parseArgs(['--max-pulls', '1SO']);
      expect(args.invalid).toContain('--max-pulls needs a positive number');
      expect(args.maxPulls).toBeUndefined();
    });

    it('refuses a window that is not a number, and a trailing --windows with nothing after it', () => {
      expect(parseArgs(['--days', 'fourteen']).invalid).toContain('--days needs a positive number');
      expect(parseArgs(['--windows', '7,lots']).invalid).toContain('--windows needs a positive number');
      expect(() => parseArgs(['--windows'])).not.toThrow();
      expect(parseArgs(['--windows']).invalid).toContain('--windows needs a positive number');
    });

    it('keeps the first unrecognised argument, not the value that follows it', () => {
      expect(parseArgs(['--max-pull', '50']).unknown).toBe('--max-pull');
    });

    it('takes a model path as given', () => {
      const args = parseArgs(['--model', 'out/model.json']);
      expect(args.model).toBe('out/model.json');
    });

    it('refuses a --model with no path', () => {
      expect(parseArgs(['--model']).invalid).toContain('--model needs a path');
    });

    it('no longer knows the flags that chose a page', () => {
      expect(parseArgs(['--json']).unknown).toBe('--json');
      expect(parseArgs(['--out', 'out/page.html']).unknown).toBe('--out');
    });
  });

  describe('a window given by hand is read as whole days, and only ever sent', () => {
    it('reads --to as the end of that day', () => {
      const args = parseArgs(['--send', '--from', '2026-07-25', '--to', '2026-08-24']);
      expect(args).toMatchObject({ send: true, from: new Date('2026-07-25T00:00:00Z'), to: new Date('2026-08-25T00:00:00Z') });
      expect(args.invalid).toBeUndefined();
    });

    it.each([
      { situation: 'a window that is not sent', argv: ['--from', '2026-07-25'], complaint: '--from needs --send' },
      { situation: 'an end with no start', argv: ['--send', '--to', '2026-07-25'], complaint: '--to needs --from' },
      { situation: 'an end before its start', argv: ['--send', '--from', '2026-07-25', '--to', '2026-07-24'], complaint: '--to cannot be before --from' },
      { situation: 'a day that does not exist', argv: ['--send', '--from', '2026-02-30'], complaint: '--from needs a day as YYYY-MM-DD' },
      { situation: 'timelines alone with no window, which only the backfill sends', argv: ['--send', '--timelines-only'], complaint: '--timelines-only needs --from' },
    ])('refuses $situation', ({ argv, complaint }) => {
      expect(parseArgs(argv).invalid).toContain(complaint);
    });
  });

  describe('a run writes its model and draws no page', () => {
    const model = buildModel({ pulls: [], now: new Date('2026-09-21T12:00:00Z'), requestedDays: 14, coveredSince: new Date('2026-09-07T12:00:00Z'), repo: 'o/r' });

    it.each([
      { situation: 'told nothing', argv: [], file: /out[\\/]model\.json$/ },
      { situation: 'given a path', argv: ['--model', 'somewhere/else.json'], file: /somewhere[\\/]else\.json$/ },
    ])('writes the model as JSON to its file when $situation', ({ argv, file }) => {
      const written = output(parseArgs(argv), model);
      expect(written.file).toMatch(file);
      expect(JSON.parse(written.content)).toMatchObject({ repo: 'o/r', coverage: { pulls: 0 } });
      expect(written.content).not.toContain('<html');
    });

    it('keeps the model file in ISO UTC times', () => {
      const dated = buildModel({ pulls: [], now: new Date('2026-10-22T13:05:00Z'), requestedDays: 14, coveredSince: new Date('2026-10-08T13:05:00Z'), repo: 'o/r' });
      const file = JSON.parse(output(parseArgs([]), dated).content);
      expect([file.generatedAt, file.coverage.coveredSince, file.coverage.until]).toEqual(['2026-10-22T13:05:00.000Z', '2026-10-08T13:05:00.000Z', '2026-10-22T13:05:00.000Z']);
    });
  });
});
