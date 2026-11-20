import { describe, expect, it } from 'vitest';
import { readPage, type AnswerBlock } from '../../../src/ai/page-summary.js';

/**
 * L1: what a pasted link's page says of itself, and which answers may be used
 * at all ("Capture link summaries", issue 1853). Whether the real model fetches
 * and answers in this shape is the contract tier's
 * (apps/api/tests/contract/summarise-a-page.v1.test.ts).
 */

const FETCHED: AnswerBlock = {
  type: 'web_fetch_tool_result',
  content: { type: 'web_fetch_result', url: 'https://example.com/a', content: { type: 'document' } },
};
const answer = (said: unknown): AnswerBlock => ({ type: 'text', text: JSON.stringify(said) });
const READ = {
  readable: true,
  title: 'How we cut our build times',
  gist: 'A team explains how caching halved its build times.',
  bullets: ['Cache the dependencies', 'Split the tests', 'Measure first'],
  language: 'English',
};

describe('Capture', () => {
  describe('a page is summarised only from an answer that fits its shape, after a page was fetched', () => {
    it('a title, a gist and 3 to 5 bullets is a page', () => {
      expect(readPage([FETCHED, answer(READ)], 'end_turn')).toEqual({
        page: { title: READ.title, gist: READ.gist, bullets: READ.bullets, language: 'English' },
      });
    });

    it.each([
      { situation: 'the model said it cannot be read', blocks: [FETCHED, answer({ readable: false, title: '', gist: '', bullets: [], language: '' })] },
      { situation: 'a title over 200 characters', blocks: [FETCHED, answer({ ...READ, title: 'x'.repeat(201) })] },
      { situation: 'two bullets', blocks: [FETCHED, answer({ ...READ, bullets: ['one', 'two'] })] },
      { situation: 'six bullets', blocks: [FETCHED, answer({ ...READ, bullets: ['1', '2', '3', '4', '5', '6'] })] },
      { situation: 'a field it was never asked for', blocks: [FETCHED, answer({ ...READ, priority: 'high' })] },
      { situation: 'a due date and panels', blocks: [FETCHED, answer({ ...READ, dueDate: '2026-12-01', panels: ['Work'] })] },
      { situation: 'text that is not JSON', blocks: [FETCHED, { type: 'text', text: 'Sure, here is a summary' }] },
      { situation: 'no text', blocks: [FETCHED] },
      { situation: 'no page fetched, however well it fits', blocks: [answer(READ)] },
      {
        situation: 'the fetch returned an error block',
        blocks: [{ type: 'web_fetch_tool_result', content: { type: 'web_fetch_tool_error', error_code: 'url_not_accessible' } }, answer(READ)],
      },
    ])('$situation is not readable', ({ blocks }) => {
      expect(readPage(blocks, 'end_turn')).toHaveProperty('notReadable');
    });

    it.each([
      { situation: 'a gist holding a Markdown link', said: { gist: 'Read [this](https://evil.example) first.' } },
      { situation: 'a bullet naming an address', said: { bullets: ['Sign in at https://evil.example', 'two', 'three'] } },
    ])('$situation is not readable, since a page cannot put a heading or a link into the description', ({ said }) => {
      expect(readPage([FETCHED, answer({ ...READ, ...said })], 'end_turn')).toHaveProperty('notReadable');
    });

    it('a heading, list or quote marker the page starts a text with is dropped', () => {
      const read = readPage([FETCHED, answer({ ...READ, gist: '# Verify your account', bullets: ['- one', '> two', '1. three'] })], 'end_turn');

      expect(read).toMatchObject({ page: { gist: 'Verify your account', bullets: ['one', 'two', 'three'] } });
    });

    it.each(['refusal', 'pause_turn'])('an answer that stopped as %s is not readable', (stopped) => {
      expect(readPage([FETCHED, answer(READ)], stopped)).toHaveProperty('notReadable');
    });

    it('a page cannot start a list or a heading in the description by what it writes: every text is one line', () => {
      const read = readPage([FETCHED, answer({ ...READ, title: 'Two\nlines', bullets: ['a\n- b', 'c', 'd'] })], 'end_turn');

      expect(read).toMatchObject({ page: { title: 'Two lines', bullets: ['a - b', 'c', 'd'] } });
    });
  });
});
