import { describe, expect, it } from 'vitest';

import { parseArgs } from '../../src/cli.js';

describe('parseArgs', () => {
  it('reads the windows to report as a list of days', () => {
    expect(parseArgs(['--windows', '1,7,30']).windows).toEqual([1, 7, 30]);
  });

  it('reports on the last 30 days over 7 and 30 when told nothing', () => {
    const args = parseArgs([]);
    expect(args.windows).toEqual([7, 30]);
    expect(args.days).toBeUndefined();
    expect(args.invalid).toBeUndefined();
  });

  it('keeps the first unrecognised argument, not the value that follows it', () => {
    // A misspelled flag leaves its value looking like an argument too, and
    // naming that instead sends the reader after the wrong word.
    expect(parseArgs(['--branhc', 'main']).unknown).toBe('--branhc');
  });

  it('refuses a budget that is not a number, rather than reading it as no budget', () => {
    // Number('8OO') is NaN and every comparison against NaN is false, so an
    // unchecked typo would not shrink the request budget but remove it.
    const args = parseArgs(['--max-runs', '8OO']);
    expect(args.invalid).toContain('--max-runs needs a positive number');
    expect(args.maxRuns).toBeUndefined();
  });

  it('refuses a window that is not a number, which would otherwise read as no window at all', () => {
    expect(parseArgs(['--days', 'thirty']).invalid).toContain('--days needs a positive number');
    expect(parseArgs(['--windows', '7,lots']).invalid).toContain('--windows needs a positive number');
  });

  it('refuses a trailing --windows with nothing after it, rather than throwing out of the parser', () => {
    // main calls parseArgs outside any catch, so a TypeError here would be a
    // stack trace and exit 1 where every other bad argument gets the usage
    // message and exit 2.
    expect(() => parseArgs(['--windows'])).not.toThrow();
    expect(parseArgs(['--windows']).invalid).toContain('--windows');
  });

  it('refuses zero and a negative count, which are numbers and still not windows', () => {
    expect(parseArgs(['--days', '0']).invalid).toContain('--days');
    expect(parseArgs(['--max-runs', '-5']).invalid).toContain('--max-runs');
  });

  it('reports the first complaint rather than the last, so the fix is the one named', () => {
    expect(parseArgs(['--days', 'x', '--max-runs', 'y']).invalid).toContain('--days');
  });

  it('takes a repository, a branch and an output path as given', () => {
    const args = parseArgs(['--repo', 'o/r', '--branch', 'trunk', '--out', 'a/b.html', '--json']);
    expect(args).toMatchObject({ repo: 'o/r', branch: 'trunk', out: 'a/b.html', json: true });
  });

  it('takes a model path as given', () => {
    const args = parseArgs(['--model', 'out/model.json']);
    expect(args.model).toBe('out/model.json');
  });

  it('refuses a --model with no path', () => {
    expect(parseArgs(['--model']).invalid).toContain('--model needs a path');
  });
});

describe('CI stability', () => {
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

  describe('the tests of an old failure are read from its annotations or log only when the send is asked to', () => {
    it('takes --old-failures with --send, and refuses it on a page', () => {
      expect(parseArgs(['--send', '--old-failures']).oldFailures).toBe(true);
      expect(parseArgs(['--old-failures']).invalid).toContain('--old-failures needs --send');
      expect(parseArgs(['--send']).oldFailures).toBeUndefined();
    });
  });

  describe("the attempts on branches other than main's are only ever sent, and write no page", () => {
    it('takes --branches with --send, and a window by hand beside it', () => {
      const args = parseArgs(['--send', '--branches', '--from', '2026-10-01']);
      expect(args).toMatchObject({ send: true, branches: true, from: new Date('2026-10-01T00:00:00Z') });
      expect(args.invalid).toBeUndefined();
    });

    it.each([
      { situation: 'sending nothing', argv: ['--branches'], complaint: '--branches needs --send' },
      { situation: 'a page to write', argv: ['--send', '--branches', '--out', 'a.html'], complaint: '--branches writes no page' },
      { situation: 'a model to write', argv: ['--send', '--branches', '--model', 'm.json'], complaint: '--branches writes no page' },
      { situation: 'the model written instead of the page', argv: ['--send', '--branches', '--json'], complaint: '--branches writes no page' },
    ])('refuses --branches with $situation', ({ argv, complaint }) => {
      expect(parseArgs(argv).invalid).toContain(complaint);
    });
  });
});
