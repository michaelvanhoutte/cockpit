import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyTheDatabase, send, usage } from './support';

beforeEach(emptyTheDatabase);

const page = async () => {
  const response = await SELF.fetch('https://monitor.test/');
  expect(response.headers.get('content-type')).toContain('text/html');
  return response.text();
};

describe('Harness Monitor', () => {
  describe('the daily page shows tokens per day', () => {
    it('days with requests get one line each, newest first, with tokens by kind', async () => {
      await send([
        usage('old', { time: '2026-03-01T10:00:00Z', inputTokens: 1_000, outputTokens: 2_000, cacheCreationTokens: 3_000, cacheReadTokens: 4_000 }),
        usage('old2', { time: '2026-03-01T11:00:00Z', inputTokens: 1 }),
        usage('new', { time: '2026-03-03T10:00:00Z', category: 'after-push', inputTokens: 7 }),
      ]);

      const html = await page();
      const days = [...html.matchAll(/<tr><td>(\d{4}-\d{2}-\d{2})<\/td>/g)].map((m) => m[1]);
      expect(days).toEqual(['2026-03-03', '2026-03-01']);
      expect(html).toContain('<td>2026-03-01</td><td>2</td><td>1,001</td><td>2,020</td><td>3,030</td><td>4,040</td>');
      expect(html).not.toContain('Nothing yet');
    });

    it('with no requests yet it says there is nothing yet rather than an empty table', async () => {
      const html = await page();

      expect(html).toContain('Nothing yet');
      expect(html).not.toContain('<table');
    });
  });
});
