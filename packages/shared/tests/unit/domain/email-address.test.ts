import { describe, expect, it } from 'vitest';
import { EMAIL_LOCAL_PART_LENGTH, emailLocalPartSchema, newEmailLocalPart } from '../../../src/index.js';

/**
 * L1: what an Email to Cockpit address may be before its `@`, and the one the
 * browser makes ("Get an Email to Cockpit address, and receive mail at it",
 * issue 1466). That the server refuses anything else is
 * apps/api/tests/integration/http/email-to-cockpit.test.ts's.
 */

describe('Email to Cockpit', () => {
  describe('an address is at least 16 lower-case letters and digits before the @, and nothing else', () => {
    it.each([
      { situation: 'sixteen letters and digits', localPart: 'k7f3q9xwk7f3q9xw', kept: true },
      { situation: 'sixty-four of them', localPart: 'a'.repeat(64), kept: true },
      { situation: 'fifteen of them', localPart: 'k7f3q9xwk7f3q9x', kept: false },
      { situation: 'sixty-five of them', localPart: 'a'.repeat(65), kept: false },
      { situation: 'a capital letter', localPart: 'K7f3q9xwk7f3q9xw', kept: false },
      { situation: 'a dot', localPart: 'k7f3q9xw.k7f3q9xw', kept: false },
      { situation: 'a plus', localPart: 'k7f3q9xwk7f3q9xw+tag', kept: false },
      { situation: 'an accented letter', localPart: 'k7f3q9xwk7f3q9xé', kept: false },
    ])('$situation is kept: $kept', ({ localPart, kept }) => {
      expect(emailLocalPartSchema.safeParse(localPart).success).toBe(kept);
    });
  });

  describe('a new address is made at random, and is always one that is kept', () => {
    it.each([
      { situation: 'every byte the lowest', byte: 0 },
      { situation: 'every byte the highest', byte: 255 },
      { situation: 'every byte in between', byte: 157 },
    ])('with $situation', ({ byte }) => {
      const made = newEmailLocalPart((bytes) => bytes.fill(byte));
      expect(made).toHaveLength(EMAIL_LOCAL_PART_LENGTH);
      expect(emailLocalPartSchema.safeParse(made).success).toBe(true);
    });

    it('uses no 0, 1, o or l, which read alike when typed from a screen', () => {
      const every = Array.from({ length: 256 }, (_, byte) => newEmailLocalPart((bytes) => bytes.fill(byte))[0]).join('');
      expect(new Set(every).size).toBe(32);
      expect(every).not.toMatch(/[01ol]/);
    });

    it('differs each time it is made', () => {
      expect(newEmailLocalPart()).not.toBe(newEmailLocalPart());
    });
  });
});
