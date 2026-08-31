import { describe, expect, it } from 'vitest';
import { safeReturnPath, worthReporting } from '../../../src/http/app.js';

/**
 * Unit level, because none of this needs a real dependency to be proved.
 *
 * For the reporting rule it is also the *only* level it can be proved at. The
 * obvious test — hold a stream open, drop the listener, assert nothing was
 * reported — was written first and thrown away: it passed identically with the
 * handler, without the handler, and with the handler's guard removed. Under the
 * test runner, cancelling a reader does not tear down the work in flight the way
 * a real listener leaving does under `wrangler dev`, so the error never arose
 * and the test could not fail. It read as coverage while proving nothing.
 *
 * That the teardown reaches the decision at all is workerd's behaviour, and is
 * verified by running the app: before this, a `wrangler dev` session logged
 * twelve `Uncaught Error: Network connection lost` from ordinary closed tabs.
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

describe('Sign-in', () => {
  /**
   * Every branch of this is a decision about a string, so it belongs here
   * rather than in the integration test, which now proves only that the route
   * reaches it and hands the answer to the browser.
   */
  describe('signing in again returns you into Cockpit and nowhere else', () => {
    const situations = [
      { situation: 'an ordinary page inside Cockpit', asked: '/w/ws-work', lands: '/w/ws-work' },
      { situation: 'the start page', asked: '/', lands: '/' },
      { situation: 'no page at all', asked: undefined, lands: '/' },
      { situation: 'another site entirely', asked: 'https://elsewhere.example/inbox', lands: '/' },
      { situation: 'a bare host', asked: 'elsewhere.example/inbox', lands: '/' },
      { situation: 'a site borrowing our protocol', asked: '//elsewhere.example/inbox', lands: '/' },
      { situation: 'a site disguised with a backslash', asked: '/\\elsewhere.example/inbox', lands: '/' },
      { situation: 'a smuggled line break', asked: '/w/ws-work\r\nSet-Cookie: a=b', lands: '/' },
      { situation: 'a smuggled null', asked: '/w/ws-work\u0000', lands: '/' },
    ];

    it.each(situations)('sends you back to $situation', ({ asked, lands }) => {
      expect(safeReturnPath(asked)).toBe(lands);
    });
  });
});
