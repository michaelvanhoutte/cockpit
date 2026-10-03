import { describe, expect, it, vi } from 'vitest';

import { main, output, parseArgs } from '../../src/cli.js';
import { buildModel } from '../../src/model.js';

describe('Lead time', () => {
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

    it('refuses a model path that would overwrite the page, before fetching anything', async () => {
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        expect(await main(['--out', 'out/page.html', '--model', 'out/page.html'])).toBe(2);
        expect(stderr.mock.calls.join('')).toContain('--model and --out cannot be the same path');
      } finally {
        stderr.mockRestore();
      }
    });
  });

  describe('the command writes the page, or with --json the model', () => {
    const model = buildModel({ pulls: [], now: new Date('2026-09-21T12:00:00Z'), requestedDays: 14, coveredSince: new Date('2026-09-07T12:00:00Z'), repo: 'o/r' });

    it('writes the page when told nothing', () => {
      const { file, content } = output(parseArgs([]), model);
      expect(file).toBe('index.html');
      expect(content).toMatch(/^<!doctype html>/);
    });

    it('writes the model rather than the page with --json', () => {
      const { file, content } = output(parseArgs(['--json']), model);
      expect(file).toBe('model.json');
      expect(JSON.parse(content)).toMatchObject({ repo: 'o/r', coverage: { pulls: 0 } });
      expect(content).not.toContain('<html');
    });
  });
});
