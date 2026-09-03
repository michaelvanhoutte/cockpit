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
        answer: json({ ok: true, register: true, store: true }),
        reach: 'reachable',
      },
      {
        // A bad answer is still an answer: the connection is plainly fine, and
        // calling this unreachable would tell the person they are offline when
        // they are not.
        situation: 'it answers with a failure',
        answer: json({ error: 'nope' }, 503),
        reach: 'reachable',
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
