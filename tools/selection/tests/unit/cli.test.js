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

  it('takes a repository, a branch and an output path as given', () => {
    const args = parseArgs(['--repo', 'o/r', '--branch', 'trunk', '--out', 'a/b.html', '--json']);
    expect(args).toMatchObject({ repo: 'o/r', branch: 'trunk', out: 'a/b.html', json: true });
  });

  it('takes a model path as given', () => {
    const args = parseArgs(['--model', 'out/model.json']);
    expect(args.model).toBe('out/model.json');
  });
});

describe('Selection', () => {
  describe('the command writes the page, or with --json the model', () => {
    const model = buildModel({
      pulls: [],
      now: new Date('2026-09-21T12:00:00Z'),
      requestedDays: 14,
      coveredSince: new Date('2026-09-07T12:00:00Z'),
      repo: 'o/r',
    });

    it('writes the page when told nothing', () => {
      const { file, content } = output(parseArgs([]), model);
      expect(file).toBe('index.html');
      expect(content).toMatch(/^<!doctype html>/);
    });

    it('writes the model rather than the page with --json', () => {
      const { file, content } = output(parseArgs(['--json']), model);
      expect(file).toBe('model.json');
      expect(JSON.parse(content)).toMatchObject({ repo: 'o/r' });
      expect(content).not.toContain('<html');
    });
  });
});
