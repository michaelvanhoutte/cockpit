import { describe, expect, it } from 'vitest';
import type { Conversation } from '@cockpit/shared';
import { agoLabel, conversationLine, conversationOpensAt, latestText, openLabel } from '../../src/conversationLine';

/**
 * F1: what a row says of the conversation its Item follows ("A Gmail starred
 * conversation is one Item whose status follows who wrote last", issue 1705),
 * in the wording the row was agreed on. That the row draws it in place of the
 * source and sender is the browser walk's (tests/e2e/conversations.test.ts).
 */

const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function aConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    itemId: '018f0000-0000-7000-8000-000000000002',
    source: 'gmail',
    conversationId: 't-1',
    link: 'https://mail.google.com/mail/?authuser=anna%40example.com#all/t-1',
    lastBy: 'them',
    lastFrom: 'Steven Noels',
    lastAt: minutesAgo(60 * 24),
    lastExcerpt: 'Thursday is tricky, how about Friday?',
    messageCount: 2,
    startedAt: minutesAgo(60 * 24 * 3),
    withWhom: 'Steven Noels',
    ...overrides,
  };
}

describe('Triage', () => {
  describe('a followed conversation’s row says who wrote last, and how long ago', () => {
    it.each([
      { situation: 'their reply yesterday', conversation: aConversation(), line: 'Gmail · Steven replied yesterday' },
      { situation: 'your message two days ago', conversation: aConversation({ lastBy: 'you', lastFrom: 'Anna Peeters', lastAt: minutesAgo(60 * 48) }), line: 'Gmail · You wrote 2 days ago' },
      { situation: 'their first message three days ago', conversation: aConversation({ messageCount: 1, lastAt: minutesAgo(60 * 72) }), line: 'Gmail · Steven wrote 3 days ago' },
      { situation: 'their reply with no name of its own', conversation: aConversation({ lastFrom: null }), line: 'Gmail · Steven replied yesterday' },
    ])('$situation: $line', ({ conversation, line }) => {
      expect(conversationLine(conversation, 'Gmail', NOW)).toBe(line);
    });

    it.each([
      { situation: 'under a minute', minutes: 0, says: 'just now' },
      { situation: 'twelve minutes', minutes: 12, says: '12 min ago' },
      { situation: 'three hours', minutes: 180, says: 'today' },
      { situation: 'a day and a bit', minutes: 60 * 30, says: 'yesterday' },
      { situation: 'four days', minutes: 60 * 24 * 4, says: '4 days ago' },
    ])('says $says for $situation', ({ minutes, says }) => {
      expect(agoLabel(minutesAgo(minutes), NOW)).toBe(says);
    });

    it.each([
      { situation: 'late last night, read this morning', sent: new Date(2026, 9, 8, 23, 30), seen: new Date(2026, 9, 9, 9, 0), says: 'yesterday' },
      { situation: 'late two nights back, read just after midnight', sent: new Date(2026, 9, 7, 23, 0), seen: new Date(2026, 9, 9, 1, 0), says: '2 days ago' },
      { situation: 'early this morning, read tonight', sent: new Date(2026, 9, 9, 0, 30), seen: new Date(2026, 9, 9, 23, 0), says: 'today' },
    ])('counts by calendar day on this device: $says for $situation', ({ sent, seen, says }) => {
      expect(agoLabel(sent.toISOString(), seen.getTime())).toBe(says);
    });

    it('names a *Last, First* sender by the first name', () => {
      expect(conversationLine(aConversation({ lastFrom: 'Noels, Steven' }), 'Gmail', NOW)).toBe('Gmail · Steven replied yesterday');
    });

    it('shows the latest message’s first lines, and who wrote it, on hover', () => {
      expect(latestText(aConversation())).toBe('Steven Noels: Thursday is tricky, how about Friday?');
      expect(latestText(aConversation({ lastBy: 'you', lastExcerpt: 'Sure!' }))).toBe('You: Sure!');
    });

    it('opens the latest email at its source, and only a web address', () => {
      expect(openLabel('Gmail')).toBe('Open the latest email in Gmail');
      expect(conversationOpensAt(aConversation())).toBe('https://mail.google.com/mail/?authuser=anna%40example.com#all/t-1');
      expect(conversationOpensAt(aConversation({ link: 'javascript:alert(1)' }))).toBeNull();
    });
  });
});
