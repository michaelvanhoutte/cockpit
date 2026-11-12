import { describe, expect, it } from 'vitest';
import { REPLY_BODY_LIMIT, readReplyBody } from '../../../src/ai/reply-body.js';

/**
 * L1: reading what the model wrote as a reply ("Mail follow-up: Reply… in Gmail
 * makes an empty draft…", issue 1730). Every answer that is not a body ends in
 * no draft at all.
 */

const answer = (over: Record<string, unknown> = {}) => JSON.stringify({ language: 'English', body: 'Hi Steven,\n\nThursday works. [which time?]\n\nAnna', ...over });

describe('Triage', () => {
  describe('what Claude wrote is a draft’s body only if it is one', () => {
    it.each([
      { situation: 'a body with line breaks', raw: answer(), body: 'Hi Steven,\n\nThursday works. [which time?]\n\nAnna' },
      { situation: 'a body with Windows line breaks', raw: answer({ body: 'Hi\r\nthere' }), body: 'Hi\nthere' },
      { situation: 'a body with spaces around it', raw: answer({ body: '  Hi there.  \n' }), body: 'Hi there.' },
      { situation: 'a body outside ASCII', raw: answer({ language: 'Dutch', body: 'Dag Steven, donderdag past ✓' }), body: 'Dag Steven, donderdag past ✓' },
    ])('is kept for $situation', ({ raw, body }) => {
      expect(readReplyBody(raw)).toEqual({ body });
    });

    it.each([
      { situation: 'an empty body', raw: answer({ body: ' \n ' }) },
      { situation: 'a body longer than a draft this size holds', raw: answer({ body: 'x'.repeat(REPLY_BODY_LIMIT + 1) }) },
      { situation: 'an answer that is not JSON', raw: 'Here is a draft: Hi Steven' },
      { situation: 'an answer of the wrong shape', raw: JSON.stringify({ body: 'Hi' }) },
      { situation: 'an answer with no text', raw: undefined },
    ])('is no draft for $situation', ({ raw }) => {
      expect(readReplyBody(raw)).toHaveProperty('discarded');
    });
  });
});
