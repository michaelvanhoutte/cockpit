import { describe, expect, it } from 'vitest';
import { authenticationOf, heldPartOf } from '../../../src/email/receive.js';

/**
 * L1: which address a mail is to, and what of it the log keeps ("Get an Email
 * to Cockpit address, and receive mail at it", issue 1466). That a mail to an
 * address nobody holds is rejected, and one to a held address is logged and
 * dropped, is apps/api/tests/integration/http/email-to-cockpit.test.ts's.
 */

const DOMAIN = 'in.cockpit.example';
const PART = 'k7f3q9xwk7f3q9xwk7f3';

describe('Email to Cockpit', () => {
  describe('a mail is to an address only where it names this environment’s domain and an address Cockpit could have made', () => {
    it.each([
      { situation: 'an address made here', to: `${PART}@${DOMAIN}`, domain: DOMAIN, part: PART },
      { situation: 'the same written in capitals', to: `${PART.toUpperCase()}@IN.COCKPIT.EXAMPLE`, domain: DOMAIN, part: PART },
      { situation: 'another domain', to: `${PART}@cockpit.example`, domain: DOMAIN, part: null },
      { situation: 'a name Cockpit never makes', to: `michael@${DOMAIN}`, domain: DOMAIN, part: null },
      { situation: 'a tag after a plus', to: `${PART}+news@${DOMAIN}`, domain: DOMAIN, part: null },
      { situation: 'no @ at all', to: PART, domain: DOMAIN, part: null },
      { situation: 'an environment that receives no mail', to: `${PART}@${DOMAIN}`, domain: undefined, part: null },
    ])('$situation', ({ to, domain, part }) => {
      expect(heldPartOf(to, domain)).toBe(part);
    });
  });

  describe('the log of a mail keeps how it was authenticated and never what it says', () => {
    it('keeps the results headers whole, the signer of a DKIM signature, and every header’s name', () => {
      const headers = new Headers({
        'authentication-results': 'mx.cloudflare.net; dkim=pass header.d=gmail.com; spf=pass; dmarc=pass header.from=gmail.com',
        'arc-authentication-results': 'i=1; mx.cloudflare.net; dmarc=pass',
        'received-spf': 'pass (mx.cloudflare.net: domain of sender@gmail.com designates 209.85.1.1 as permitted sender)',
        'dkim-signature': 'v=1; a=rsa-sha256; c=relaxed/relaxed; d=gmail.com; s=20230601; h=from:subject; bh=abc=; b=SIGNATURE',
        subject: 'Quarterly numbers for Jan',
        from: 'Sender <sender@gmail.com>',
      });

      const logged = authenticationOf(headers);

      expect(logged).toEqual({
        'authentication-results': 'mx.cloudflare.net; dkim=pass header.d=gmail.com; spf=pass; dmarc=pass header.from=gmail.com',
        'arc-authentication-results': 'i=1; mx.cloudflare.net; dmarc=pass',
        'received-spf': 'pass (mx.cloudflare.net: domain of sender@gmail.com designates 209.85.1.1 as permitted sender)',
        'dkim-signature': { d: 'gmail.com', s: '20230601' },
        headerNames: expect.arrayContaining(['subject', 'from', 'dkim-signature', 'received-spf']),
      });
      expect(JSON.stringify(logged)).not.toContain('Quarterly');
      expect(JSON.stringify(logged)).not.toContain('SIGNATURE');
    });

    it('says only which headers there were where none of them authenticates it', () => {
      expect(authenticationOf(new Headers({ subject: 'hello' }))).toEqual({ headerNames: ['subject'] });
    });
  });
});
