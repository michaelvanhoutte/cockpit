import { describe, expect, it } from 'vitest';

import { parseArgs, output } from '../../src/cli.js';
import { buildModel } from '../../src/model.js';

describe('parseArgs', () => {
  it('reads the windows to report as a list of days', () => {
    expect(parseArgs(['--windows', '1,7,30']).windows).toEqual([1, 7, 30]);
  });

  it('reports over 7 and 14 days when told nothing', () => {
    const args = parseArgs([]);
    expect(args.windows).toEqual([7, 14]);
    expect(args.days).toBeUndefined();
    expect(args.invalid).toBeUndefined();
  });

  it('keeps the first unrecognised argument, not the value that follows it', () => {
    expect(parseArgs(['--branhc', 'main']).unknown).toBe('--branhc');
  });

  it('refuses a budget that is not a number, rather than reading it as no budget', () => {
    const args = parseArgs(['--max-pulls', '8OO']);
    expect(args.invalid).toContain('--max-pulls needs a positive number');
    expect(args.maxPulls).toBeUndefined();
  });

  it('refuses a window that is not a number, which would otherwise read as no window at all', () => {
    expect(parseArgs(['--days', 'thirty']).invalid).toContain('--days needs a positive number');
    expect(parseArgs(['--windows', '7,lots']).invalid).toContain('--windows needs a positive number');
  });

  it('refuses a trailing --windows with nothing after it, rather than throwing out of the parser', () => {
    expect(() => parseArgs(['--windows'])).not.toThrow();
    expect(parseArgs(['--windows']).invalid).toContain('--windows');
  });

  it('refuses zero and a negative count, which are numbers and still not windows', () => {
    expect(parseArgs(['--days', '0']).invalid).toContain('--days');
    expect(parseArgs(['--max-pulls', '-5']).invalid).toContain('--max-pulls');
  });

  it('reports the first complaint rather than the last, so the fix is the one named', () => {
    expect(parseArgs(['--days', 'x', '--max-pulls', 'y']).invalid).toContain('--days');
  });

  it('takes a repository, a branch and a model path as given', () => {
    const args = parseArgs(['--repo', 'o/r', '--branch', 'trunk', '--model', 'a/b.json']);
    expect(args).toMatchObject({ repo: 'o/r', branch: 'trunk', model: 'a/b.json' });
  });

  it('no longer knows the flags that chose a page', () => {
    expect(parseArgs(['--json']).unknown).toBe('--json');
    expect(parseArgs(['--out', 'a/b.html']).unknown).toBe('--out');
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
    ])('refuses $situation', ({ argv, complaint }) => {
      expect(parseArgs(argv).invalid).toContain(complaint);
    });
  });

  it('takes a model path as given', () => {
    const args = parseArgs(['--model', 'out/model.json']);
    expect(args.model).toBe('out/model.json');
  });

  it('refuses a --model with no path', () => {
    expect(parseArgs(['--model']).invalid).toContain('--model needs a path');
  });
});

describe('Selection', () => {
  describe('a run writes its model and draws no page', () => {
    const model = buildModel({
      pulls: [],
      now: new Date('2026-09-21T12:00:00Z'),
      requestedDays: 14,
      coveredSince: new Date('2026-09-07T12:00:00Z'),
      repo: 'o/r',
    });

    it.each([
      { situation: 'told nothing', argv: [], file: /out[\\/]model\.json$/ },
      { situation: 'given a path', argv: ['--model', 'somewhere/else.json'], file: /somewhere[\\/]else\.json$/ },
    ])('writes the model as JSON to its file when $situation', ({ argv, file }) => {
      const written = output(parseArgs(argv), model);
      expect(written.file).toMatch(file);
      expect(JSON.parse(written.content)).toMatchObject({ repo: 'o/r' });
      expect(written.content).not.toContain('<html');
    });
  });
});
