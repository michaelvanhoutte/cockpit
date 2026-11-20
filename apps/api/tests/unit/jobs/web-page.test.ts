import { describe, expect, it } from 'vitest';
import type { AiService, PageRead } from '../../../src/ai/index.js';
import type { Env } from '../../../src/env.js';
import { hostOf, readTheWebPage, textsOfThePage, webLinkIn } from '../../../src/jobs/web-page.js';

/**
 * L1: how the clean-up job puts a note's web page together ("Capture link
 * summaries", issue 1853): which link it reads, what it makes of the answer,
 * and what a failed read leaves. The model is the AI layer's own interface,
 * faked; what the store does with the result is held in
 * apps/api/tests/integration/http/web-page-links.test.ts.
 */

const env = {} as Env;
const PAGE = {
  title: 'How we cut our build times',
  gist: 'A team explains how caching halved its build times.',
  bullets: ['Cache the dependencies', 'Split the tests', 'Measure first'],
  language: 'English',
};
const SUMMARY = `${PAGE.gist}\n\n- ${PAGE.bullets.join('\n- ')}`;
const own = (capturedMessage: string) => ({ source: 'internal', sourceId: null, sourceLink: null, capturedMessage });
const CALL = { accountName: 'a', itemId: 'i', triggeredBy: 'captured-in-app' as const };

const answering = (read: PageRead | Error): AiService =>
  ({
    summarisePage: async () => {
      if (read instanceof Error) throw read;
      return read;
    },
  }) as unknown as AiService;

describe('Capture', () => {
  describe('only an Own note’s first web link is read', () => {
    it.each([
      { situation: 'a typed note', item: own('read https://example.com/a'), link: 'https://example.com/a' },
      { situation: 'a PDF link', item: own('https://example.com/report.pdf'), link: 'https://example.com/report.pdf' },
      { situation: 'a note with two web links', item: own('https://a.example.com/x https://b.example.com/y'), link: 'https://a.example.com/x' },
      { situation: 'a note captured over MCP with a Teams link, which no Teams read reaches', item: { ...own('https://teams.microsoft.com/l/message/19:a/1 https://example.com/a'), source: 'mcp', sourceId: 'client-1' }, link: 'https://example.com/a' },
      { situation: 'a note captured over MCP', item: { ...own('read https://example.com/a'), source: 'mcp', sourceId: 'client-1' }, link: 'https://example.com/a' },
      { situation: 'an app’s capture', item: { ...own('read https://example.com/a'), source: 'gmail', sourceId: 'msg-1' }, link: null },
      { situation: 'a note with a Teams link and a web link: the web link stays plain', item: own('https://teams.microsoft.com/l/message/19:a/1 https://example.com/a'), link: null },
      { situation: 'a note already read', item: { ...own('https://example.com/a'), source: 'web', sourceLink: 'https://example.com/a' }, link: null },
      { situation: 'a link longer than 2,000 characters', item: own(`https://example.com/${'a'.repeat(2_000)}`), link: null },
      { situation: 'a note with no link', item: own('call the dentist'), link: null },
    ])('$situation', ({ item, link }) => {
      expect(webLinkIn(env, item)).toBe(link);
    });
  });

  describe('a note with one web link is titled with the page’s name and described with your words, then the summary', () => {
    it.each([
      { situation: 'a bare link', words: '', cleaned: 'https://example.com/a', description: SUMMARY },
      { situation: 'a link with words beside it', words: 'call her back Friday', cleaned: 'Call her back on Friday.', description: `Call her back on Friday.\n\n${SUMMARY}` },
    ])('$situation', ({ words, cleaned, description }) => {
      const texts = textsOfThePage({ page: PAGE, wordsBeside: words }, { description: cleaned, readings: [] });

      expect(texts).toEqual({ title: PAGE.title, description, readings: [] });
    });

    it('keeps the Next action and the other readings the words made', () => {
      const readings = [{ title: 'Other', description: '', meaning: 'm' }];

      expect(textsOfThePage({ page: PAGE, wordsBeside: 'words' }, { description: 'Words.', readings, nextAction: 'Call' })).toMatchObject({ readings, nextAction: 'Call' });
    });
  });

  describe('a read page names its source as the site, without a leading www.', () => {
    it.each([
      { link: 'https://www.example.com/a', host: 'example.com' },
      { link: 'https://blog.example.com/a', host: 'blog.example.com' },
      { link: 'http://Example.com/a?x=1', host: 'example.com' },
    ])('$link is $host', ({ link, host }) => {
      expect(hostOf(link)).toBe(host);
    });

    it('is Web, with the link as its source link and the typed note left as it was', async () => {
      const read = await readTheWebPage(answering({ page: PAGE }), { capturedMessage: 'read https://www.example.com/a today' }, 'https://www.example.com/a', CALL, false);

      expect(read).toMatchObject({
        capturedFrom: { source: 'web', sourceLink: 'https://www.example.com/a', sender: 'example.com' },
        capturedMessage: 'read https://www.example.com/a today',
        wordsBeside: 'read today',
      });
    });
  });

  describe('a page that cannot be read leaves a normal note', () => {
    const typed = { capturedMessage: 'https://example.com/a' };

    it.each([false, true])('an answer that says it is not readable, on the last try %s: nothing is read', async (last) => {
      expect(await readTheWebPage(answering({ notReadable: 'a login wall' }), typed, typed.capturedMessage, CALL, last)).toBeNull();
    });

    it('a call that fails on the last try: nothing is read', async () => {
      expect(await readTheWebPage(answering(new Error('down')), typed, typed.capturedMessage, CALL, true)).toBeNull();
    });

    it('a call that fails before the last try: the job fails, so the queue tries it again', async () => {
      await expect(readTheWebPage(answering(new Error('down')), typed, typed.capturedMessage, CALL, false)).rejects.toThrow('down');
    });
  });
});
