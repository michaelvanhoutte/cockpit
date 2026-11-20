import { describe, expect, it } from 'vitest';
import { firstMessageLink, firstWebLink, webLinks, wordsBesideTheLink, wordsBesideTheLinks } from '../../../src/domain/message-link.js';

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

describe('Capture', () => {
  describe('the first web page link of a note is the one read, and a link a connector declared never is', () => {
    it.each([
      { situation: 'a bare link', typed: 'https://example.com/2026/some-slug', link: 'https://example.com/2026/some-slug' },
      { situation: 'a PDF link', typed: 'read https://example.com/report.pdf today', link: 'https://example.com/report.pdf' },
      { situation: 'an http link', typed: 'http://example.com/a', link: 'http://example.com/a' },
      { situation: 'two links', typed: 'https://a.example.com/x and https://b.example.com/y', link: 'https://a.example.com/x' },
      { situation: 'a link closing a sentence', typed: 'see https://example.com/a.', link: 'https://example.com/a' },
      { situation: 'a Markdown link', typed: 'see [the page](https://example.com/a) today', link: 'https://example.com/a' },
      { situation: 'a Teams link, then a page', typed: `${LINK} and https://example.com/a`, link: 'https://example.com/a' },
      { situation: 'no link', typed: 'call the dentist', link: null },
      { situation: 'a Teams link alone', typed: LINK, link: null },
      { situation: 'an address that is not a web page', typed: 'mailto:els@example.com ftp://example.com/a', link: null },
    ])('$situation', ({ typed, link }) => {
      expect(firstWebLink(typed, DECLARED)).toBe(link);
    });
  });

  describe('webLinks', () => {
    it.each([
      { situation: 'three of four, in order', typed: 'https://a.example.com/1 https://a.example.com/2 https://a.example.com/3 https://a.example.com/4', limit: 3, links: ['https://a.example.com/1', 'https://a.example.com/2', 'https://a.example.com/3'] },
      { situation: 'a link written twice counts once', typed: 'https://a.example.com/1 and again https://a.example.com/1 then https://b.example.com/2', limit: 3, links: ['https://a.example.com/1', 'https://b.example.com/2'] },
      { situation: 'a declared Teams link is skipped', typed: `${LINK} https://example.com/a`, limit: 3, links: ['https://example.com/a'] },
      { situation: 'no link', typed: 'call the dentist', limit: 3, links: [] },
    ])('$situation', ({ typed, limit, links }) => {
      expect(webLinks(typed, DECLARED, limit)).toEqual(links);
    });
  });

  describe('wordsBesideTheLinks', () => {
    it.each([
      { situation: 'words around two links', typed: 'compare https://a.example.com/1 and https://b.example.com/2 today', words: 'compare and today' },
      { situation: 'bare links, one to a line', typed: 'https://a.example.com/1\nhttps://b.example.com/2', words: '' },
    ])('$situation', ({ typed, words }) => {
      expect(wordsBesideTheLinks(typed, ['https://a.example.com/1', 'https://b.example.com/2'])).toBe(words);
    });
  });
});
