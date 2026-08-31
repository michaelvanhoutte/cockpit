import { describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';

/**
 * Integration level, and through `SELF.fetch` rather than by calling the
 * handler: what this proves is a redirect the Worker performs — the status, the
 * Location header, and the routing that gets there — none of which exists below
 * the HTTP entry point ("Enter through the real interface, not around it").
 *
 * No database is touched, because signing back in does not read anything: the
 * gate in front of the Worker has already done the deciding by the time this
 * route runs at all.
 */
async function arriveBackFrom(query: string) {
  return SELF.fetch(`http://cockpit.test/v1/relogin${query}`, { redirect: 'manual' });
}

describe('Sign-in', () => {
  describe('signing in again puts you back on the page you were on', () => {
    const situations = [
      { situation: 'a workspace page', query: '?return=%2Fw%2Fws-work', lands: '/w/ws-work' },
      { situation: 'the start page', query: '?return=%2F', lands: '/' },
      { situation: 'a page that was never recorded', query: '', lands: '/' },
    ];

    it.each(situations)('sends you back to $situation', async ({ query, lands }) => {
      const res = await arriveBackFrom(query);

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(lands);
    });
  });

  describe('a return location pointing anywhere but Cockpit is refused', () => {
    const situations = [
      { situation: 'another site entirely', asked: 'https://elsewhere.example/inbox' },
      { situation: 'a site borrowing our protocol', asked: '//elsewhere.example/inbox' },
      { situation: 'a site disguised with a backslash', asked: '/\\elsewhere.example/inbox' },
      { situation: 'a location smuggling a line break', asked: '/w/ws-work\r\nSet-Cookie: a=b' },
    ];

    it.each(situations)('refuses $situation and starts you at the top', async ({ asked }) => {
      const res = await arriveBackFrom(`?return=${encodeURIComponent(asked)}`);

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/');
    });

    it('keeps an ordinary page inside Cockpit', async () => {
      const res = await arriveBackFrom('?return=%2Fw%2Fws-personal');

      expect(res.headers.get('location')).toBe('/w/ws-personal');
    });
  });
});
