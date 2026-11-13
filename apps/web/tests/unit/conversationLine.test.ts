import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Conversation } from '@cockpit/shared';
import {
  agoLabel,
  conversationCountLine,
  conversationLine,
  conversationOpensAt,
  conversationSourceName,
  latestText,
  openLabel,
} from '../../src/conversationLine';
import { deviceIsIn, deviceSpeaks } from './support/timeZone';

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
  afterEach(() => vi.restoreAllMocks());

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

    it.each([
      { situation: 'four emails', conversation: aConversation({ messageCount: 4, startedAt: '2026-10-04T10:00:00.000Z' }), line: 'With Steven Noels · 4 emails since 4 Oct' },
      { situation: 'one email', conversation: aConversation({ messageCount: 1, startedAt: '2026-10-04T10:00:00.000Z' }), line: 'With Steven Noels · 1 email on 4 Oct' },
      { situation: 'nobody else yet', conversation: aConversation({ withWhom: null, startedAt: '2026-10-04T10:00:00.000Z' }), line: '2 emails since 4 Oct' },
    ])('counts $situation for the form: $line', ({ conversation, line }) => {
      deviceIsIn('Europe/Brussels');
      deviceSpeaks('nl-BE');
      expect(conversationCountLine(conversation, NOW)).toBe(line);
    });

    it('reads Draft started while a draft Email… made is unsent, with nothing to show on hover yet', () => {
      const drafting = aConversation({ draftStarted: true, lastBy: 'you', lastFrom: null, lastExcerpt: '', messageCount: 1 });

      expect(conversationLine(drafting, 'Gmail', NOW)).toBe('Gmail · Draft started');
      expect(latestText(drafting)).toBe('');
    });

    it('reads Claude drafted an answer while Claude’s draft is unsent, opening the draft', () => {
      const claudes = aConversation({ draftStarted: true, claudeDrafted: true, lastBy: 'you', lastFrom: null, lastExcerpt: '', messageCount: 1 });

      expect(conversationLine(claudes, 'Outlook', NOW)).toBe('Outlook · Claude drafted an answer');
      expect(openLabel(claudes, 'Outlook')).toBe('Open the draft in Outlook');
    });

    it('opens the latest email at its source, and only a web address', () => {
      expect(openLabel(aConversation(), 'Gmail')).toBe('Open the latest email in Gmail');
      expect(conversationOpensAt(aConversation())).toBe('https://mail.google.com/mail/?authuser=anna%40example.com#all/t-1');
      expect(conversationOpensAt(aConversation({ link: 'javascript:alert(1)' }))).toBeNull();
    });
  });

  describe('a LinkedIn conversation is known by its notifications only', () => {
    const linkedIn = aConversation({
      conversationId: 'linkedin:2-ZmFrZXRocmVhZA==',
      link: 'https://www.linkedin.com/messaging/thread/2-ZmFrZXRocmVhZA==/',
      messageCount: 1,
      lastAt: minutesAgo(60 * 72),
    });

    it('names LinkedIn as the source, whatever connector brought the notification', () => {
      const names = { gmail: 'Gmail' };
      expect(conversationSourceName(linkedIn, names)).toBe('LinkedIn');
      expect(conversationSourceName(aConversation(), names)).toBe('Gmail');
      expect(conversationLine(linkedIn, conversationSourceName(linkedIn, names), NOW)).toBe('LinkedIn · Steven wrote 3 days ago');
    });

    it('opens the conversation in LinkedIn, not the latest email', () => {
      expect(openLabel(linkedIn, 'LinkedIn')).toBe('Open the conversation in LinkedIn');
      expect(conversationOpensAt(linkedIn)).toBe('https://www.linkedin.com/messaging/thread/2-ZmFrZXRocmVhZA==/');
    });

    it('gives no count of messages, only who it is with', () => {
      expect(conversationCountLine({ ...linkedIn, messageCount: 4 }, NOW)).toBe('With Steven Noels');
      expect(conversationCountLine({ ...linkedIn, withWhom: null }, NOW)).toBe('');
    });
  });
});
