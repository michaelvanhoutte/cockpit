import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyTheDatabase, send, storedRequestIds, totals, usage } from './support';

beforeEach(emptyTheDatabase);

const requestsCounted = async () => (await totals()).reduce((sum, t) => sum + t.requests, 0);
const inputCounted = async () => (await totals()).reduce((sum, t) => sum + t.input_tokens, 0);

describe('Harness Monitor', () => {
  describe('a request is counted once, however often and by whichever path it arrives', () => {
    it('the same batch sent twice leaves the totals as the first send made them', async () => {
      const batch = [usage('r1'), usage('r2', { inputTokens: 5 })];
      expect(await (await send(batch)).json()).toEqual({ stored: 2, ignored: 0 });
      const after = await totals();

      expect(await (await send(batch)).json()).toEqual({ stored: 0, ignored: 2 });
      expect(await totals()).toEqual(after);
      expect(await inputCounted()).toBe(15);
    });

    it('a batch overlapping one already stored counts only its new requests', async () => {
      await send([usage('r1'), usage('r2')]);
      const response = await send([usage('r2'), usage('r3'), usage('r4')]);

      expect(await response.json()).toEqual({ stored: 2, ignored: 1 });
      expect(await requestsCounted()).toBe(4);
      expect(await storedRequestIds()).toEqual(['r1', 'r2', 'r3', 'r4']);
    });

    it('a request sent by the hook and again by an upload is counted once, keeping the first', async () => {
      await send([usage('r1', { source: 'hook', inputTokens: 10 })]);
      await send([usage('r1', { source: 'upload', inputTokens: 999 })]);

      const row = await env.DB.prepare('SELECT source, input_tokens FROM usage_requests WHERE request_id = ?')
        .bind('r1')
        .first<{ source: string; input_tokens: number }>();
      expect(row).toEqual({ source: 'hook', input_tokens: 10 });
      expect(await inputCounted()).toBe(10);
    });

    it('a request carried by two sessions, as a forked session does, is counted once', async () => {
      await send([usage('r1', { sessionId: 'original' })]);
      await send([usage('r1', { sessionId: 'fork' }), usage('r2', { sessionId: 'fork' })]);

      expect(await requestsCounted()).toBe(2);
      const owner = await env.DB.prepare('SELECT session_id FROM usage_requests WHERE request_id = ?')
        .bind('r1')
        .first<{ session_id: string }>();
      expect(owner?.session_id).toBe('original');
    });

    it('two overlapping batches arriving at the same moment count each request once', async () => {
      const first = Array.from({ length: 30 }, (_, i) => usage(`r${i}`));
      const second = Array.from({ length: 30 }, (_, i) => usage(`r${i + 15}`));

      const responses = await Promise.all([send(first), send(second), send(first)]);
      const stored = (await Promise.all(responses.map((r) => r.json() as Promise<{ stored: number }>))).reduce(
        (sum, r) => sum + r.stored,
        0,
      );

      expect(stored).toBe(45);
      expect(await storedRequestIds()).toHaveLength(45);
      expect(await requestsCounted()).toBe(45);
      expect(await inputCounted()).toBe(450);
    });
  });
});
