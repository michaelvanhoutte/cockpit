import { describe, expect, it } from 'vitest';
import { worthReporting } from '../../../src/http/app.js';

/**
 * Unit level, and it is the only level this rule can be proved at. The obvious
 * test — hold a stream open, drop the listener, assert nothing was reported —
 * was written first and thrown away: it passed identically with the handler,
 * without the handler, and with the handler's guard removed. Under the test
 * runner, cancelling a reader does not tear down the work in flight the way a
 * real listener leaving does under `wrangler dev`, so the error never arose and
 * the test could not fail. It read as coverage while proving nothing.
 *
 * What is left is the decision itself, which is the whole of what this change
 * added. That the teardown reaches that decision at all is workerd's behaviour
 * and is verified by running the app: before this, a `wrangler dev` session
 * logged twelve `Uncaught Error: Network connection lost` from ordinary closed
 * tabs.
 */
describe('Offline', () => {
  describe('closing the app while it is listening for changes is not an error', () => {
    const situations = [
      { situation: 'the listener has gone away', aborted: true, closed: false, reported: false },
      { situation: 'the stream has already ended', aborted: false, closed: true, reported: false },
      {
        situation: 'something went wrong while someone was still listening',
        aborted: false,
        closed: false,
        reported: true,
      },
    ];

    it.each(situations)('$situation', ({ aborted, closed, reported }) => {
      expect(worthReporting({ aborted, closed })).toBe(reported);
    });
  });
});
