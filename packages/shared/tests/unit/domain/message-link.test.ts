import { describe, expect, it } from 'vitest';
import { firstMessageLink, wordsBesideTheLink } from '../../../src/domain/message-link.js';

/**
 * L1: what a person typed beside a pasted message link, once the link is read
 * ("Read pasted Teams links", issue 1755). Which link counts is proved where
 * the app opens one (apps/web/tests/unit/itemSource.test.ts).
 */

const LINK = 'https://teams.microsoft.com/l/message/19:abc@thread.v2/1731490000000?context=%7B%7D';
const DECLARED = { teams: [{ host: 'teams.microsoft.com', pathStart: '/l/message/' }] };

describe('Capture', () => {
  describe('the words you type beside a pasted message link become its note, the link left out', () => {
    it.each([
      { situation: 'the link alone', typed: LINK, note: '' },
      { situation: 'words after it', typed: `${LINK} call her back Friday`, note: 'call her back Friday' },
      { situation: 'words before it', typed: `call her back ${LINK}`, note: 'call her back' },
      { situation: 'words either side, on one line', typed: `ask Els ${LINK} by Friday`, note: 'ask Els by Friday' },
      { situation: 'words on lines of their own', typed: `ask Els\n${LINK}\nby Friday`, note: 'ask Els\nby Friday' },
      { situation: 'the link closing a sentence', typed: `see ${LINK}.`, note: 'see .' },
      { situation: 'the link written as a Markdown link', typed: `see [the message](${LINK}) today`, note: 'see today' },
      { situation: 'the link written as a Markdown autolink', typed: `<${LINK}> call her back`, note: 'call her back' },
      { situation: 'the link written as a Markdown link named by itself', typed: `see [${LINK}](${LINK}) today`, note: 'see today' },
    ])('$situation', ({ typed, note }) => {
      const found = firstMessageLink(typed, DECLARED)!;

      expect(wordsBesideTheLink(typed, found.link)).toBe(note);
    });
  });
});
