import { describe, expect, it } from 'vitest';
import { returnPathFrom } from '../../../src/auth/return-path.js';

/**
 * L1: every spelling of "somewhere else" a sign-in must refuse to come back
 * to. That the callback really lands on the path, and on `/` for anything
 * refused here, is tests/integration/http/connected-apps.test.ts's.
 */
describe('Sign-in', () => {
  describe('a sign-in comes back only to a path on Cockpit itself', () => {
    it.each([
      { situation: 'the consent page an app opened', asked: '/oauth/authorize?client_id=a&state=b', back: '/oauth/authorize?client_id=a&state=b' },
      { situation: 'a path with dots in it, settled first', asked: '/w/../oauth/authorize', back: '/oauth/authorize' },
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
      { situation: 'something too long to be a page here', asked: `/${'a'.repeat(1_000)}`, back: null },
      { situation: 'something that grows too long once settled', asked: `/${'"'.repeat(400)}`, back: null },
      { situation: 'the longest page kept', asked: `/${'a'.repeat(999)}`, back: `/${'a'.repeat(999)}` },
    ])('$situation', ({ asked, back }) => {
      expect(returnPathFrom(asked)).toBe(back);
    });
  });
});
