import { describe, expect, it } from 'vitest';
import type { AiService, PageRead } from '../../../src/ai/index.js';
import type { Env } from '../../../src/env.js';
import { hostOf, readTheWebPages, textsOfThePage, webLinksIn } from '../../../src/jobs/web-page.js';

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

const answering = (read: PageRead | Error | ((link: string) => PageRead | Error)): AiService =>
  ({
    summarisePage: async (link: string) => {
      const answer = typeof read === 'function' ? read(link) : read;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  }) as unknown as AiService;

const pageTitled = (title: string) => ({ ...PAGE, title });
const under = (title: string) => `**${title}**\n\n${SUMMARY}`;
const A = 'https://a.example.com/x';
const B = 'https://www.b.example.org/y';
const C = 'https://c.example.net/z';

describe('Capture', () => {
  describe('only an Own note’s first 3 web links are read', () => {
    it.each([
      { situation: 'a typed note', item: own('read https://example.com/a'), links: ['https://example.com/a'] },
      { situation: 'a PDF link', item: own('https://example.com/report.pdf'), links: ['https://example.com/report.pdf'] },
      { situation: 'a note with two web links', item: own('https://a.example.com/x https://b.example.com/y'), links: ['https://a.example.com/x', 'https://b.example.com/y'] },
      { situation: 'a note with four web links: the first three', item: own('https://a.example.com/1 https://a.example.com/2 https://a.example.com/3 https://a.example.com/4'), links: ['https://a.example.com/1', 'https://a.example.com/2', 'https://a.example.com/3'] },
      { situation: 'a note captured over MCP with a Teams link, which no Teams read reaches', item: { ...own('https://teams.microsoft.com/l/message/19:a/1 https://example.com/a'), source: 'mcp', sourceId: 'client-1' }, links: ['https://example.com/a'] },
      { situation: 'a note captured over MCP', item: { ...own('read https://example.com/a'), source: 'mcp', sourceId: 'client-1' }, links: ['https://example.com/a'] },
      { situation: 'an app’s capture', item: { ...own('read https://example.com/a'), source: 'gmail', sourceId: 'msg-1' }, links: [] },
      { situation: 'a note with a Teams link and a web link: the web link stays plain', item: own('https://teams.microsoft.com/l/message/19:a/1 https://example.com/a'), links: [] },
      { situation: 'a note already read', item: { ...own('https://example.com/a'), source: 'web', sourceLink: 'https://example.com/a' }, links: [] },
      { situation: 'a link longer than 2,000 characters', item: own(`https://example.com/${'a'.repeat(2_000)}`), links: [] },
      { situation: 'a note with no link', item: own('call the dentist'), links: [] },
    ])('$situation', ({ item, links }) => {
      expect(webLinksIn(env, item)).toEqual(links);
    });
  });

  describe('a note with one web link is titled with the page’s name and described with your words, then the summary', () => {
    it.each([
      { situation: 'a bare link', words: '', cleaned: 'https://example.com/a', description: SUMMARY },
      { situation: 'a link with words beside it', words: 'call her back Friday', cleaned: 'Call her back on Friday.', description: `Call her back on Friday.\n\n${SUMMARY}` },
    ])('$situation', ({ words, cleaned, description }) => {
      const texts = textsOfThePage({ pages: [{ link: A, page: PAGE }], wordsBeside: words, words, linksAsked: 1 }, { description: cleaned, readings: [] });

      expect(texts).toEqual({ title: PAGE.title, description, readings: [] });
    });

    it('keeps the Next action and the other readings the words made', () => {
      const readings = [{ title: 'Other', description: '', meaning: 'm' }];

      expect(textsOfThePage({ pages: [{ link: A, page: PAGE }], wordsBeside: 'words', words: 'words', linksAsked: 1 }, { description: 'Words.', readings, nextAction: 'Call' })).toMatchObject({ readings, nextAction: 'Call' });
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
      const read = await readTheWebPages(answering({ page: PAGE }), { capturedMessage: 'read https://www.example.com/a today' }, ['https://www.example.com/a'], CALL, false);

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
      expect(await readTheWebPages(answering({ notReadable: 'a login wall' }), typed, [typed.capturedMessage], CALL, last)).toBeNull();
    });

    it('a call that fails on the last try: nothing is read', async () => {
      expect(await readTheWebPages(answering(new Error('down')), typed, [typed.capturedMessage], CALL, true)).toBeNull();
    });

    it('a call that fails before the last try: the job fails, so the queue tries it again', async () => {
      await expect(readTheWebPages(answering(new Error('down')), typed, [typed.capturedMessage], CALL, false)).rejects.toThrow('down');
    });
  });

  describe('several pages: each summary sits under its page’s title, in the order the links appear', () => {
    const both = [
      { link: A, page: pageTitled('First') },
      { link: B, page: pageTitled('Second') },
    ];

    it.each([
      {
        situation: 'two links with words: the title from your words',
        words: 'compare them',
        cleaned: { title: 'Compare a and b', description: 'Compare them.' },
        expected: { title: 'Compare a and b', description: `Compare them.\n\n${under('First')}\n\n${under('Second')}` },
      },
      {
        situation: 'two links with no words: the first page’s title, and the summaries alone',
        words: '',
        cleaned: { title: 'Two links', description: `${A} ${B}` },
        expected: { title: 'First', description: `${under('First')}\n\n${under('Second')}` },
      },
    ])('$situation', ({ words, cleaned, expected }) => {
      const texts = textsOfThePage({ pages: both, wordsBeside: words, words, linksAsked: 2 }, { ...cleaned, readings: [] });

      expect(texts).toEqual({ ...expected, readings: [] });
    });

    it('a page title with asterisks stays inside its bold', () => {
      const texts = textsOfThePage({ pages: [{ link: A, page: pageTitled('a **b**') }, both[1]!], wordsBeside: '', words: '', linksAsked: 2 }, { description: '', readings: [] });

      expect(texts.description).toContain('**a \\*\\*b\\*\\***');
    });

    it('two links of which one is not readable, with words: the title is still from your words', () => {
      const texts = textsOfThePage({ pages: [both[0]!], wordsBeside: `compare ${B}`, words: 'compare', linksAsked: 2 }, { title: 'Compare a and b', description: `Compare ${B}`, readings: [] });

      expect(texts.title).toBe('Compare a and b');
    });

    it('a link not read stays in your cleaned-up words, which still come first', () => {
      const texts = textsOfThePage({ pages: [both[0]!], wordsBeside: B, words: '', linksAsked: 2 }, { description: B, readings: [] });

      expect(texts.description).toBe(`${B}\n\n${SUMMARY}`);
      expect(texts.title).toBe('First');
    });
  });

  describe('what was read lands, and what was not stays plain', () => {
    const captured = { capturedMessage: `${A} ${B} ${C}` };
    const links = [A, B, C];

    it('the second of three not readable: the first and third are read, in order', async () => {
      const ai = answering((link) => (link === B ? { notReadable: 'a login wall' } : { page: pageTitled(link) }));

      const read = await readTheWebPages(ai, captured, links, CALL, false);

      expect(read?.pages.map((one) => one.link)).toEqual([A, C]);
      expect(read?.wordsBeside).toBe(B);
      expect(read?.words).toBe('');
    });

    it('the first not readable: the source link and sender are the second’s', async () => {
      const ai = answering((link) => (link === A ? { notReadable: 'a login wall' } : { page: PAGE }));

      const read = await readTheWebPages(ai, captured, links, CALL, false);

      expect(read?.capturedFrom).toMatchObject({ source: 'web', sourceLink: B, sender: 'b.example.org' });
    });

    it('none readable: nothing is read', async () => {
      expect(await readTheWebPages(answering({ notReadable: 'a login wall' }), captured, links, CALL, false)).toBeNull();
    });
  });

  describe('a site that does not answer retries the whole job, until its last try', () => {
    const captured = { capturedMessage: `${A} ${B}` };
    const oneDown = answering((link) => (link === B ? new Error('down') : { page: PAGE }));

    it('before the last try: the job throws', async () => {
      await expect(readTheWebPages(oneDown, captured, [A, B], CALL, false)).rejects.toThrow('down');
    });

    it('on the last try: the others are read, and that link stays plain', async () => {
      const read = await readTheWebPages(oneDown, captured, [A, B], CALL, true);

      expect(read?.pages.map((one) => one.link)).toEqual([A]);
      expect(read?.wordsBeside).toBe(B);
    });
  });
});
