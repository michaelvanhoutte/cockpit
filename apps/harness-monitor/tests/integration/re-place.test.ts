import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyTheDatabase, send, usage, WRITE_KEY } from './support';

beforeEach(emptyTheDatabase);

const withKey = { authorization: `Bearer ${WRITE_KEY}` };

/** A batch of corrections as the re-place step sends it. */
function correct(corrections: unknown[], headers: Record<string, string> = withKey) {
  return SELF.fetch('https://monitor.test/v1/usage/corrections', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ corrections }),
  });
}

async function phaseOf(requestId: string): Promise<string | undefined> {
  const row = await env.DB.prepare('SELECT category FROM usage_requests WHERE request_id = ?').bind(requestId).first<{ category: string }>();
  return row?.category;
}

/** The instant phase marks began, and the second before it. */
const FROM = '2026-09-21T00:00:00Z';
const BEFORE = '2026-09-20T23:59:59Z';

describe('Harness Monitor', () => {
  describe('a request is placed again only from Unphased, from 21 Sep on, and the answer says how many changed and were left', () => {
    it.each([
      { situation: 'an Unphased request from 21 Sep on, to Outside the process', stored: { category: 'unphased', time: FROM }, to: 'outside-process', now: 'outside-process', changed: 1 },
      { situation: 'an Unphased request, to Scoping & planning', stored: { category: 'unphased' }, to: 'scoping-planning', now: 'scoping-planning', changed: 1 },
      { situation: 'an Unphased request, to After push', stored: { category: 'unphased' }, to: 'after-push', now: 'after-push', changed: 1 },
      { situation: 'an Unphased request, to Process review', stored: { category: 'unphased' }, to: 'process-review', now: 'process-review', changed: 1 },
      { situation: 'a request already in Building', stored: { category: 'building' }, to: 'outside-process', now: 'building', changed: 0 },
      { situation: 'an Unphased request the second before 21 Sep', stored: { category: 'unphased', time: BEFORE }, to: 'outside-process', now: 'unphased', changed: 0 },
      { situation: 'a request the monitor does not hold', stored: null, to: 'outside-process', now: undefined, changed: 0 },
    ])('$situation', async ({ stored, to, now, changed }) => {
      if (stored) await send([usage('r1', stored)]);

      const response = await correct([{ requestId: 'r1', category: to }]);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ changed, left: 1 - changed });
      expect(await phaseOf('r1')).toBe(now);
    });

    it.each([
      { situation: 'no write key', headers: {}, status: 401 },
      { situation: 'a wrong write key', headers: { authorization: 'Bearer not-the-key' }, status: 401 },
      {
        situation: 'a batch with one correction into Building',
        headers: withKey,
        status: 400,
        corrections: [
          { requestId: 'r1', category: 'outside-process' },
          { requestId: 'r2', category: 'building' },
        ],
      },
    ])('$situation is refused and nothing changes', async ({ headers, status, corrections }) => {
      await send([usage('r1', { category: 'unphased' }), usage('r2', { category: 'unphased' })]);

      const response = await correct(corrections ?? [{ requestId: 'r1', category: 'outside-process' }], headers);

      expect(response.status).toBe(status);
      expect([await phaseOf('r1'), await phaseOf('r2')]).toEqual(['unphased', 'unphased']);
    });

    it('the count of requests from 21 Sep on still Unphased needs the write key', async () => {
      await send([
        usage('kept', { category: 'unphased' }),
        usage('placed', { category: 'unphased' }),
        usage('older', { category: 'unphased', time: BEFORE }),
        usage('building', { category: 'building' }),
      ]);
      await correct([{ requestId: 'placed', category: 'outside-process' }]);

      const refused = await SELF.fetch('https://monitor.test/v1/usage/corrections');
      const counted = await SELF.fetch('https://monitor.test/v1/usage/corrections', { headers: withKey });

      expect(refused.status).toBe(401);
      expect(await counted.json()).toEqual({ unphased: 1 });
    });
  });

  describe('placing requests again a second time changes only what earlier runs did not reach', () => {
    it('the same batch sent twice changes nothing the second time and leaves all of it', async () => {
      await send([usage('r1', { category: 'unphased' }), usage('r2', { category: 'unphased' })]);
      const batch = [
        { requestId: 'r1', category: 'outside-process' },
        { requestId: 'r2', category: 'scoping-planning' },
      ];

      const first = await (await correct(batch)).json();
      const second = await (await correct(batch)).json();

      expect([first, second]).toEqual([
        { changed: 2, left: 0 },
        { changed: 0, left: 2 },
      ]);
      expect([await phaseOf('r1'), await phaseOf('r2')]).toEqual(['outside-process', 'scoping-planning']);
    });

    it('an Unphased request an older hook sent after a run is the only one the re-run changes', async () => {
      await send([usage('r1', { category: 'unphased' })]);
      await correct([{ requestId: 'r1', category: 'outside-process' }]);
      await send([usage('r2', { category: 'unphased' })]);

      const rerun = await (
        await correct([
          { requestId: 'r1', category: 'outside-process' },
          { requestId: 'r2', category: 'after-push' },
        ])
      ).json();

      expect(rerun).toEqual({ changed: 1, left: 1 });
      expect([await phaseOf('r1'), await phaseOf('r2')]).toEqual(['outside-process', 'after-push']);
    });
  });
});
