import { describe, expect, it } from 'vitest';
import { buildSummariseAPage } from '../../../../src/ai/prompts/summarise-a-page.v1.js';

/**
 * L1: what the page call is built from ("Capture link summaries", issue 1853):
 * the versioned prompt, the link and, where the note has words beside it, those
 * words as a hint for which language to write in, and nothing of the account. Whether the
 * model obeys it is the contract tier's.
 */
describe('Capture', () => {
  describe('a page is summarised by a call that carries the link and a language hint alone, so a page can change only its own summary', () => {
    const prompt = buildSummariseAPage('https://example.com/a');
    const sent = [prompt.system.instructions, prompt.system.stable, prompt.system.recent, prompt.message].join('\n');

    it('shows the instructions and the link, with no learning context', () => {
      expect(prompt.message).toBe('The link: https://example.com/a');
      expect(prompt.system.instructions).toContain('only a hint for which language to write in');
      expect(prompt.system.stable).toBe('');
      expect(prompt.system.recent).toBe('');
    });

    it('carries the words beside the link as a hint for the language, and a bare link none', () => {
      const hinted = buildSummariseAPage('https://example.com/a', 'lees dit voor vrijdag');

      expect(hinted.message).toBe(`The link: https://example.com/a

The person's note, only a hint for which language to write in:
lees dit voor vrijdag`);
      expect(buildSummariseAPage('https://example.com/a', '  ').message).toBe('The link: https://example.com/a');
      expect(hinted.system).toEqual(prompt.system);
    });

    it.each(['Panel', 'history', 'filed', 'corrected'])('shows nothing of the account: no %s', (word) => {
      expect(sent).not.toContain(word);
    });

    it('lets the page fetch once, capped, on Sonnet 5.5 at low effort', () => {
      expect(prompt).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'low' });
      expect(prompt.tools).toEqual([{ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 1, max_content_tokens: 20_000 }]);
    });

    it('asks for no field outside the page summary', () => {
      expect(prompt.schema).toMatchObject({
        required: ['readable', 'title', 'gist', 'bullets', 'language'],
        additionalProperties: false,
      });
    });
  });
});
