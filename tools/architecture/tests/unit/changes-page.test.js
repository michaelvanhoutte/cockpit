import { describe, expect, it } from 'vitest';

import { buildModel } from '../../src/model.js';
import { renderHtml } from '../../src/render/html.js';
import { descriptionFile } from '../support/description.js';

const model = buildModel({ wrangler: { file: 'apps/api/wrangler.jsonc', text: '{ "name": "w" }' }, workflows: [], description: descriptionFile(), commit: 'b'.repeat(40), date: '2026-10-08T10:00:00+02:00' });
const from = { commit: 'a'.repeat(40), date: '2026-10-06T10:00:00+02:00', repo: null };
const compared = (changes, extra = {}) => ({ state: 'compared', from, to: model.drawnFrom, changes, descriptionFromElsewhere: false, ...extra });
const section = (comparison) => renderHtml(model, { comparison }).match(/<section id="changes">([\s\S]*?)<\/section>/)[1];

describe('What changed', () => {
  describe('the page shows what changed, at the top', () => {
    it('sits before the Context', () => {
      const page = renderHtml(model, { comparison: compared([]) });
      expect(page.indexOf('id="changes"')).toBeGreaterThan(-1);
      expect(page.indexOf('id="changes"')).toBeLessThan(page.indexOf('id="context"'));
    });

    it('names both commits compared and lists each change with where and a flag', () => {
      const text = section(compared([{ type: 'Mark', change: 'added', text: 'web names Gmail', where: ['apps/web/src/a.ts'], flag: { label: 'new source mark', tone: 'call' } }]));
      expect(text).toContain('aaaaaaa');
      expect(text).toContain('bbbbbbb');
      expect(text).toContain('web names Gmail');
      expect(text).toContain('<code>apps/web/src/a.ts</code>');
      expect(text).toContain('<span class="pill p-hand">new source mark</span>');
    });

    it('says when the earlier commit was drawn with this one’s description file', () => {
      expect(section(compared([], { descriptionFromElsewhere: true }))).toContain('has no description file');
    });
  });

  describe('with nothing to compare against, the page says so and lists nothing', () => {
    it.each([
      { situation: 'nothing differs', comparison: compared([]), says: 'Nothing changed.' },
      { situation: 'there is no live report yet', comparison: { state: 'first' }, says: 'This is the first report' },
      { situation: 'the live model could not be read', comparison: { state: 'unavailable', reason: 'the previous model is not valid JSON' }, says: 'There is nothing to compare: the previous model is not valid JSON.' },
      { situation: 'no comparison was asked for', comparison: undefined, says: 'There is nothing to compare' },
    ])('$situation', ({ comparison, says }) => {
      const text = section(comparison);
      expect(text).toContain(says);
      expect(text).not.toContain('<table');
    });
  });
});
