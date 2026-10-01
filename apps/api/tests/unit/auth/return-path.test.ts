import { describe, expect, it } from 'vitest';
import { fitsTheCookie, returnPathFrom } from '../../../src/auth/return-path.js';

/**
 * L1: every spelling of "somewhere else" a sign-in must refuse to come back
 * to. That the callback really lands on the path, and on `/` for anything
 * refused here, is tests/integration/http/connected-apps.test.ts's.
 */
describe('Sign-in', () => {
  describe('a sign-in comes back only to the consent page an app opened', () => {
    const consent = (state: string) =>
      `/oauth/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: 'abcdefghijklmnop',
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        state,
        code_challenge: 'c'.repeat(43),
        code_challenge_method: 'S256',
        resource: 'https://cockpit.example/mcp',
      })}`;

    it.each([
      { situation: 'the consent page an app opened', asked: '/oauth/authorize?client_id=a&state=b', back: '/oauth/authorize?client_id=a&state=b' },
      { situation: 'the consent page, reached through dots', asked: '/w/../oauth/authorize', back: '/oauth/authorize' },
      { situation: 'a consent page with a 1,500-character state', asked: consent('s'.repeat(1_500)), back: consent('s'.repeat(1_500)) },
      { situation: 'a page of the app other than the consent page', asked: '/w/ws-1?item=x', back: null },
      { situation: 'the app itself', asked: '/', back: null },
      { situation: 'an address that merely starts like the consent page', asked: '/oauth/authorizex', back: null },
      { situation: 'nothing asked', asked: undefined, back: null },
      { situation: 'an empty ask', asked: '', back: null },
      { situation: 'another site, in full', asked: 'https://evil.example/', back: null },
      { situation: 'another site, without its scheme', asked: '//evil.example/', back: null },
      { situation: 'another site, behind a backslash', asked: '/\\evil.example/', back: null },
      { situation: 'another site, behind a tab a browser would strip', asked: '/\t/evil.example/', back: null },
      { situation: 'a backslash further along', asked: '/oauth\\..\\evil', back: null },
      { situation: 'a script', asked: 'javascript:alert(1)', back: null },
      { situation: 'a relative path', asked: 'oauth/authorize', back: null },
      { situation: 'another site, made by settling a dot', asked: '/.//evil.example', back: null },
      { situation: 'another site, made by settling a double dot', asked: '/..//evil.example', back: null },
      { situation: 'another site, made by settling a segment away', asked: '/a/..//evil.example', back: null },
      { situation: 'another site, made by settling an encoded double dot', asked: '/%2e%2e//evil.example/x', back: null },
      { situation: 'a consent page too long for the sign-in to carry', asked: consent('s'.repeat(3_400)), back: null },
      { situation: 'a consent page that only grows too long once written into the cookie', asked: consent('%20'.repeat(500)), back: null },
    ])('$situation', ({ asked, back }) => {
      expect(returnPathFrom(asked)).toBe(back);
    });

    it('keeps the whole sign-in cookie inside what a browser keeps, at the longest consent page it carries', () => {
      let state = 's';
      while (fitsTheCookie(consent(`${state}s`))) state += 's';
      const kept = returnPathFrom(consent(state))!;
      // What the sign-in writes: its three secrets beside the path, as JSON, percent-encoded.
      const secret = 'x'.repeat(43);
      const value = encodeURIComponent(JSON.stringify({ state: secret, nonce: secret, codeVerifier: secret, returnTo: kept }));
      expect(`cockpit_sign_in_65535=${value}`.length).toBeLessThan(4_096);
    });
  });
});
