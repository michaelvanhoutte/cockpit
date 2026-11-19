import { describe, expect, it } from 'vitest';
import { phoneAddress } from '../../../src/domain/phone-link.js';

/**
 * L1: the address a source's own phone website is opened at ("Open a Gmail Item
 * at its email on a phone", issue 1837), built from what its connector
 * declares. Which Item and which device asks is proved where the app opens one
 * (apps/web/tests/unit/itemSource.test.ts).
 */

const DECLARED = {
  gmail: {
    host: 'mail.google.com',
    path: '/mail/mu/mp/',
    mailboxParam: 'authuser',
    conversationFragment: 'cv/All Mail/',
    draftsFragment: 'tl/Drafts',
    notAConversationPrefix: 'message:',
  },
};
const STORED = 'https://mail.google.com/mail/?authuser=anna%40example.com#all/18f3c0';

describe('Connector management', () => {
  describe('a source’s phone address names its conversation from All Mail, in the mailbox the stored link names', () => {
    it.each([
      {
        situation: 'a conversation of a mailbox',
        stored: STORED,
        id: '18f3c0',
        address: 'https://mail.google.com/mail/mu/mp/?authuser=anna%40example.com#cv/All%20Mail/18f3c0',
      },
      {
        situation: 'a stored link with no mailbox, which opens the first account signed in',
        stored: 'https://mail.google.com/mail/#all/18f3c0',
        id: '18f3c0',
        address: 'https://mail.google.com/mail/mu/mp/#cv/All%20Mail/18f3c0',
      },
      {
        situation: 'the Drafts folder',
        stored: STORED,
        id: null,
        address: 'https://mail.google.com/mail/mu/mp/?authuser=anna%40example.com#tl/Drafts',
      },
    ])('$situation', ({ stored, id, address }) => {
      expect(phoneAddress(DECLARED, 'gmail', stored, id)).toBe(address);
    });
  });

  describe('the address is only ever a web address on the declared host, the id one path segment of it', () => {
    it.each(['a/b', 'a#b', 'a?b=c', 'a b', '../x'])('an id holding %s', (id) => {
      const address = new URL(phoneAddress(DECLARED, 'gmail', STORED, id)!);

      expect(address.origin).toBe('https://mail.google.com');
      expect(address.pathname).toBe('/mail/mu/mp/');
      expect(address.search).toBe('?authuser=anna%40example.com');
      expect(address.hash).toBe(`#cv/All%20Mail/${encodeURIComponent(id)}`);
    });
  });

  describe('the stored link stays where there is no phone address to build', () => {
    it.each([
      { situation: 'a source that declares none', declared: DECLARED, source: 'outlook', stored: STORED, id: 'x' },
      { situation: 'no declarations at all (a copy from an older release)', declared: undefined, source: 'gmail', stored: STORED, id: 'x' },
      { situation: 'an id naming one email only', declared: DECLARED, source: 'gmail', stored: STORED, id: 'message:18f3c0' },
      { situation: 'a stored link on another host', declared: DECLARED, source: 'gmail', stored: 'https://demo.cockpit.invalid/gmail', id: 'x' },
      { situation: 'a stored link that is not a web address', declared: DECLARED, source: 'gmail', stored: 'javascript:alert(1)', id: 'x' },
      { situation: 'an id that is a prototype key', declared: DECLARED, source: 'constructor', stored: STORED, id: 'x' },
    ])('$situation', ({ declared, source, stored, id }) => {
      expect(phoneAddress(declared, source, stored, id)).toBeNull();
    });
  });
});
