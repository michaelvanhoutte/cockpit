import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_LINK_LIFETIME_MS,
  attachmentLinkKey,
  openAttachmentLink,
  sealAttachmentLink,
} from '../../../src/auth/attachment-link.js';
import { open, seal, sealingKey } from '../../../src/connectors/credential-crypto.js';

/**
 * L1, against real Web Crypto with the clock passed in: the edge of a link's
 * hour, and every malformed token, which the route answers with one 404 and so
 * cannot tell apart. That a link opens its file through the Worker, and that a
 * removed file or another account's is refused, is
 * tests/integration/http/attachment-links.test.ts's.
 */

const A_KEY = 'Y29ja3BpdC10ZXN0LWNvbm5lY3Rvci1rZXktMDAwMDA=';
const ANOTHER_KEY = 'YW5vdGhlci1rZXktZW50aXJlbHktMDAwMDAwMDAwMDA=';
const MADE_AT = new Date('2026-09-29T10:00:00.000Z');
const NAMED = { accountName: 'tenant-default', attachmentId: '018f0000-0000-7000-8000-000000000001' };
const at = (ms: number) => new Date(MADE_AT.getTime() + ms);

describe('Agents', () => {
  describe('a link sent with an agent opens only while its hour lasts, and only as it was made', () => {
    it.each([
      { situation: 'a moment before its hour is up', token: 'as made', now: at(ATTACHMENT_LINK_LIFETIME_MS - 1), opens: true },
      { situation: 'the moment its hour is up', token: 'as made', now: at(ATTACHMENT_LINK_LIFETIME_MS), opens: false },
      { situation: 'a token that is not one at all', token: 'not/base64url!', now: MADE_AT, opens: false },
      { situation: 'a token too short to hold anything', token: 'AAAA', now: MADE_AT, opens: false },
      { situation: 'a link made by another Cockpit', token: 'another key', now: MADE_AT, opens: false },
    ])('$situation', async ({ token, now, opens }) => {
      const key = (await attachmentLinkKey(A_KEY))!;
      const made =
        token === 'as made'
          ? await sealAttachmentLink(key, NAMED, MADE_AT)
          : token === 'another key'
            ? await sealAttachmentLink((await attachmentLinkKey(ANOTHER_KEY))!, NAMED, MADE_AT)
            : token;

      expect(await openAttachmentLink(key, made, now)).toEqual(opens ? NAMED : null);
    });
  });

  describe('a link’s key is not the key a connection’s credential is sealed with', () => {
    it('cannot open a sealed credential, from the same secret', async () => {
      const sealed = await seal('{"token":"t"}', (await sealingKey(A_KEY))!);
      const linkKey = (await attachmentLinkKey(A_KEY))!;

      await expect(open(sealed, linkKey)).resolves.toBeNull();
    });
  });
});
