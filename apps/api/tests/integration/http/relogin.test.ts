import { describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';

/**
 * Integration level, and through `SELF.fetch` rather than by calling the
 * handler: what this proves is that the route exists, reads the return location
 * off the query string, puts the answer in a `Location` header and says 302 —
 * none of which exists below the HTTP entry point ("Enter through the real
 * interface, not around it").
 *
 * It deliberately does *not* re-prove which locations are allowed. That is a
 * decision about a string with no dependency of any kind, so it belongs at unit
 * level and lives in apps/api/tests/unit/http/app.test.ts; repeating the table
 * here would be coverage duplicated upward. One refused case stays, because
 * "the guard is actually called on the way through" is wiring rather than
 * branching, and nothing below can show it.
 *
 * No database is touched, because signing back in reads nothing: the gate in
 * front of the Worker has already done the deciding by the time this runs.
 */
async function arriveBackFrom(query: string) {
  return SELF.fetch(`http://cockpit.test/v1/relogin${query}`, { redirect: 'manual' });
}

describe('Sign-in', () => {
  describe('signing in again puts you back on the page you were on', () => {
    it('hands the browser the page it came from', async () => {
      const res = await arriveBackFrom('?return=%2Fw%2Fws-work');

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/w/ws-work');
    });

    it('refuses a page outside Cockpit on the way through', async () => {
      const res = await arriveBackFrom(`?return=${encodeURIComponent('//elsewhere.example')}`);

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/');
    });
  });
});
