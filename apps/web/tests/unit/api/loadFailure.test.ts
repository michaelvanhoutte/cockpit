import { afterEach, describe, expect, it, vi } from 'vitest';
import { realSurroundings } from '../../../src/api/loadFailure';

/**
 * F1: what the health check concludes from an answer is pure branching, with
 * `fetch` replaced at the edge. The classification built on top of it lives in
 * LoadFailure.test.tsx, which injects these conclusions rather than producing
 * them; this is the half that decides which conclusion is reached.
 */
afterEach(() => {
  vi.unstubAllGlobals();
});

function answers(response: Response | Error) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => (response instanceof Error ? Promise.reject(response) : Promise.resolve(response))),
  );
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('Offline', () => {
  describe('Cockpit only calls itself unreachable when nothing came back at all', () => {
    const situations = [
      {
        situation: 'it answers and reports itself well',
        answer: json({ ok: true, db: true }),
        reach: 'healthy',
      },
      {
        situation: 'it answers and reports its database down',
        answer: json({ ok: false, db: false }),
        reach: 'unhealthy',
      },
      {
        situation: 'it answers with a failure',
        answer: json({ error: 'nope' }, 503),
        reach: 'unhealthy',
      },
      {
        // Something standing in front of the Worker — a sign-in page, most
        // likely. It answered, so the connection is plainly fine, and calling
        // this unreachable would tell the person they are offline when they
        // are not.
        situation: 'something answers in its place, with a page rather than an answer',
        answer: new Response('<!doctype html><title>Sign in</title>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
        reach: 'unhealthy',
      },
      {
        situation: 'nothing answers at all',
        answer: new TypeError('Failed to fetch'),
        reach: 'unreachable',
      },
    ];

    it.each(situations)('$situation', async ({ answer, reach }) => {
      answers(answer);

      await expect(realSurroundings.reachServer()).resolves.toBe(reach);
    });
  });
});
