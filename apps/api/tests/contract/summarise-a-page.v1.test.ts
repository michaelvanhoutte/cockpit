import { afterAll, describe, expect, it } from 'vitest';
import { buildSummariseAPage } from '../../src/ai/prompts/summarise-a-page.v1.js';
import { A_CONTRACT_RUN, claude, expectAKeyAndARecord } from './support/claude.js';

/**
 * The contract tier for summarising a pasted link ("Capture link summaries",
 * issue 1853): the real Claude API, Anthropic's real web fetch and the real
 * prompt, a behaviour suite run by hand and only when named -
 * `clean-up-a-note.v19.test.ts`'s class comment says why. The behaviour held is
 * the one the prompt was written to get: a public page summarised as its
 * title, a gist and 3 to 5 bullets in its own language, and a sign-in page
 * never summarised as if it were the content. Only the live API can show web
 * fetch and the prompt together; the answer's shape and what the job does with
 * it are held below (`page-summary.test.ts`, `web-page-links.test.ts`).
 */

const spent = { calls: 0, input: 0, output: 0 };
const summarising = claude((_model, usage) => {
  spent.calls += 1;
  spent.input += usage.input_tokens;
  spent.output += usage.output_tokens;
});
afterAll(() => console.log(`summarise-a-page.v1: ${JSON.stringify(spent)}`));

describe('Capture', () => {
  it('has a key to ask with and a token to record its calls under', () => {
    expectAKeyAndARecord();
    expect(buildSummariseAPage('https://example.com/')).toMatchObject({ version: 'v1', model: 'claude-sonnet-5-5', effort: 'low' });
  });

  describe('a pasted link is summarised from its page, and a page that cannot be read is never summarised', () => {
    it('a public article gives a title, a gist and 3 to 5 bullets', async () => {
      const read = await summarising.summarisePage('https://en.wikipedia.org/wiki/Ghent', '', A_CONTRACT_RUN);

      expect(read, JSON.stringify(read)).toHaveProperty('page');
      if (!('page' in read)) return;
      expect(read.page.title).toMatch(/ghent/i);
      expect(read.page.bullets.length).toBeGreaterThanOrEqual(3);
      expect(read.page.bullets.length).toBeLessThanOrEqual(5);
      expect(read.page.language.toLowerCase()).toContain('english');
    });

    it('a page in another language is summarised in that language', async () => {
      const read = await summarising.summarisePage('https://nl.wikipedia.org/wiki/Gent', '', A_CONTRACT_RUN);

      expect(read, JSON.stringify(read)).toHaveProperty('page');
      if (!('page' in read)) return;
      expect(read.page.language.toLowerCase()).toMatch(/dutch|nederlands/);
    });

    it('a note in another language than the page gets the summary in the note’s language', async () => {
      const read = await summarising.summarisePage('https://en.wikipedia.org/wiki/Ghent', 'lees dit voor het gesprek van vrijdag', A_CONTRACT_RUN);

      expect(read, JSON.stringify(read)).toHaveProperty('page');
      if (!('page' in read)) return;
      expect(read.page.language.toLowerCase()).toMatch(/dutch|nederlands/);
    });

    it('a sign-in page is not readable', async () => {
      const read = await summarising.summarisePage('https://github.com/login', '', A_CONTRACT_RUN);

      expect(read, JSON.stringify(read)).toHaveProperty('notReadable');
    });
  });
});
