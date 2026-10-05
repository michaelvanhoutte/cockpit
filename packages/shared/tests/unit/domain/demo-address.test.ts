import { describe, expect, it } from 'vitest';
import { DEMO_PAGES, demoAddress, demoPageOf, itemSchema } from '../../../src/index.js';

/**
 * L1, and pure: the reserved address the guest demo's Items link to, and what
 * it reads back as ("Seed Gmail and Teams in the guest demo", issue 773). What
 * the app then opens for each page is apps/web's (tests/unit/itemSource.test.ts).
 */
describe('Connector management', () => {
  describe('a demo address names one of the demo’s own pages, and any other link is left alone', () => {
    it.each([
      { situation: 'the Gmail page', link: 'https://demo.cockpit.invalid/gmail', reads: 'gmail' },
      { situation: 'the Teams page', link: 'https://demo.cockpit.invalid/teams', reads: 'teams' },
      { situation: 'a simulated session, named by its run', link: 'https://demo.cockpit.invalid/session/018f0000-0000', reads: 'session' },
      { situation: 'a page with a trailing slash', link: 'https://demo.cockpit.invalid/gmail/', reads: 'gmail' },
      { situation: 'the host in capitals', link: 'https://DEMO.COCKPIT.INVALID/teams', reads: 'teams' },
      { situation: 'a path on the demo host that names no page', link: 'https://demo.cockpit.invalid/whatsapp', reads: 'unknown' },
      { situation: 'the demo host with no path', link: 'https://demo.cockpit.invalid/', reads: 'unknown' },
      { situation: 'a real Gmail link', link: 'https://mail.google.com/mail/u/0/#inbox/abc', reads: null },
      { situation: 'a Teams link', link: 'https://teams.microsoft.com/l/message/1', reads: null },
      { situation: 'a host that only ends like the demo’s', link: 'https://evil.demo.cockpit.invalid.example/gmail', reads: null },
      { situation: 'the demo host over plain http', link: 'http://demo.cockpit.invalid/gmail', reads: null },
      { situation: 'something that is no address', link: 'not a url', reads: null },
    ])('$situation', ({ link, reads }) => {
      expect(demoPageOf(link)).toBe(reads);
    });

    it('keeps a detail at the end of an address, which is how one session is told from another', () => {
      expect(demoAddress('session', 'run-1')).toBe('https://demo.cockpit.invalid/session/run-1');
      expect(demoAddress('session', 'run-1')).not.toBe(demoAddress('session', 'run-2'));
    });

    it('is on a host that cannot resolve, and every page address is a link an Item may store', () => {
      for (const page of DEMO_PAGES) {
        const address = demoAddress(page);
        // RFC 6761: `.invalid` is guaranteed never to resolve, whoever registers what.
        expect(new URL(address).hostname.endsWith('.invalid'), address).toBe(true);
        expect(demoPageOf(address)).toBe(page);
        expect(
          itemSchema.shape.sourceLink.safeParse(address).success,
          `${address} is not a link an Item may hold`,
        ).toBe(true);
      }
    });
  });
});
