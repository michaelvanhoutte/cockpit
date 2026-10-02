import { describe, expect, it } from 'vitest';
import { countryOf, referrerHostOf } from '../../../src/auth/sign-in-history.js';

/**
 * L1: what is kept of where a sign-in came from. That the values reach the
 * register's row is tests/integration/http/sign-in-history.test.ts's.
 */
describe('Sign-in', () => {
  describe('a guest’s referrer is reduced to its host and never trusted', () => {
    it.each([
      { situation: 'a page address with a path and query', referrer: 'https://conselit.com/a?b=1', kept: 'conselit.com' },
      { situation: 'an address in capitals', referrer: 'HTTPS://Conselit.COM/', kept: 'conselit.com' },
      { situation: 'an address with credentials and a port', referrer: 'http://me:secret@conselit.com:8080/x', kept: 'conselit.com' },
      { situation: 'nothing', referrer: undefined, kept: null },
      { situation: 'an empty string', referrer: '', kept: null },
      { situation: 'text that is not an address', referrer: 'not a url', kept: null },
      { situation: 'an address that is not a web page', referrer: 'javascript:alert(1)', kept: null },
      { situation: 'something that is not text', referrer: { host: 'x.com' }, kept: null },
      { situation: 'an absurdly long address', referrer: `https://${'a'.repeat(3_000)}.com/`, kept: null },
      { situation: 'a host longer than is kept', referrer: `https://${'a'.repeat(150)}.com/`, kept: 'a'.repeat(100) },
    ])('keeps $kept for $situation', ({ referrer, kept }) => {
      expect(referrerHostOf(referrer)).toBe(kept);
    });
  });

  describe('a referrer on Cockpit’s own host says nothing about where somebody came from', () => {
    it.each([
      { situation: 'the same host', referrer: 'https://cockpit.test/logon', kept: null },
      { situation: 'the same host in capitals', referrer: 'https://COCKPIT.test/', kept: null },
      { situation: 'another host', referrer: 'https://conselit.com/', kept: 'conselit.com' },
    ])('keeps $kept for $situation', ({ referrer, kept }) => {
      expect(referrerHostOf(referrer, 'cockpit.test')).toBe(kept);
    });
  });

  describe('a row’s country is the one Cloudflare names, or nothing', () => {
    it.each([
      { situation: 'a country on the request', cf: { country: 'be' }, kept: 'BE' },
      { situation: 'no metadata at all', cf: undefined, kept: null },
      { situation: 'metadata without a country', cf: {}, kept: null },
      { situation: 'something that is not a country', cf: { country: 'Belgium and more' }, kept: null },
    ])('keeps $kept for $situation', ({ cf, kept }) => {
      expect(countryOf({ cf })).toBe(kept);
    });
  });
});
