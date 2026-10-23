import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { linked, pullRequest } from './github-support';
import { costRows, emptyTheDatabase, pullRequestFigures, send, spend, splitColumns, theExport, thePage, thePullRequest, whereItWent, withPrices } from './support';

beforeEach(async () => {
  await emptyTheDatabase();
  await withPrices();
});

const NEW_PHASES = [
  { phase: 'outside-process', name: 'Outside the process' },
  { phase: 'process-review', name: 'Process review' },
];

/** A pull request holding one request in each new phase and one in Building. */
async function seed() {
  await send([
    spend('out', 4, { branch: 'b/10', category: 'outside-process', sessionId: 's-out' }),
    spend('review', 2, { branch: 'b/10', category: 'process-review', sessionId: 's-review' }),
    spend('build', 1, { branch: 'b/10', category: 'building', sessionId: 's-build' }),
    spend('ci', 8, { branch: 'b/10', category: 'ci-reviews', ranWhere: 'actions', sessionId: 's-ci' }),
  ]);
  await linked(pullRequest({ number: 10, title: 'Phases', headRefName: 'b/10' }));
}

describe('Harness Monitor', () => {
  describe('the write stores Outside the process and Process review, and every phase it took before', () => {
    it.each([...NEW_PHASES.map((n) => ({ category: n.phase })), { category: 'unphased' }])('a request in $category is stored as sent', async ({ category }) => {
      const response = await send([spend('r', 1, { category })]);

      expect(response.status).toBe(200);
      const { results } = await env.DB.prepare('SELECT category FROM usage_requests').all<{ category: string }>();
      expect(results.map((r) => r.category)).toEqual([category]);
    });
  });

  describe('each new phase is named the same wherever cost is shown, in pipeline order', () => {
    it('the split names them in its legend and columns, Outside the process first and Process review last', async () => {
      await seed();

      const html = await thePage('?period=all&group=pr');

      expect(splitColumns(html)).toEqual(['Outside', 'Scoping', 'Building', 'Code rev.', 'Security rev.', 'After push', 'CI rev.', 'Process rev.']);
      expect(whereItWent(html).bar).toBe(
        'Outside the process $4.00, Scoping & planning $0.00, Building $1.00, Local code review $0.00, Local security review $0.00, After push $0.00, CI reviews $8.00, Process review $2.00',
      );
      expect(costRows(html).map((r) => r.categories)).toEqual([['$4.00', '—', '$1.00', '—', '—', '—', '$8.00', '$2.00']]);
    });

    it('grouping by category lists them in pipeline order', async () => {
      await seed();

      const html = await thePage('?period=all&group=category');

      expect(costRows(html).map((r) => [r.label, r.total])).toEqual([
        ['Outside the process', '$4.00'],
        ['Building', '$1.00'],
        ['CI reviews', '$8.00'],
        ['Process review', '$2.00'],
      ]);
    });

    it('the Category filter offers them, by name and in pipeline order, Process review last', async () => {
      const html = await thePage('?period=all');

      const select = /<select id="category"[^>]*>(.*?)<\/select>/s.exec(html)![1]!;
      expect([...select.matchAll(/<option value="([^"]*)"[^>]*>(.*?)<\/option>/g)].map((m) => [m[1], m[2]!.replace('&#38;', '&')])).toEqual([
        ['', 'All categories'],
        ['unphased', 'Unphased'],
        ['outside-process', 'Outside the process'],
        ['scoping-planning', 'Scoping & planning'],
        ['building', 'Building'],
        ['local-code-review', 'Local code review'],
        ['local-security-review', 'Local security review'],
        ['after-push', 'After push'],
        ['ci-reviews', 'CI reviews'],
        ['process-review', 'Process review'],
      ]);
    });

    it('the pull request page names them in the same places', async () => {
      await seed();

      const figures = pullRequestFigures(await (await thePullRequest(10, '?period=all')).text());

      expect(figures.categories.map((c) => [c.name, c.amount])).toEqual([
        ['Outside the process', '$4.00'],
        ['Scoping & planning', '$0.00'],
        ['Building', '$1.00'],
        ['Local code review', '$0.00'],
        ['Local security review', '$0.00'],
        ['After push', '$0.00'],
        ['CI reviews', '$8.00'],
        ['Process review', '$2.00'],
      ]);
    });

    it.each(NEW_PHASES)('the filter $phase counts that request and Building does not, on the page and in the export', async ({ phase, name }) => {
      await seed();

      const page = await thePage(`?period=all&category=${phase}`);
      const exported = await theExport(`?period=all&category=${phase}`);

      expect(whereItWent(page).bar).toBe(`${name} ${phase === 'outside-process' ? '$4.00' : '$2.00'}`);
      expect(exported.rows.map((r) => [r[1], r[exported.header.indexOf('category')]])).toEqual([[phase === 'outside-process' ? 's-out' : 's-review', phase]]);
    });

    it('the export carries the stored value, not the name', async () => {
      await seed();

      const exported = await theExport('?period=all');

      expect(exported.rows.map((r) => r[exported.header.indexOf('category')]).sort()).toEqual(['building', 'ci-reviews', 'outside-process', 'process-review']);
    });

    it('Unphased is left out of a period that holds none and shown first in one that does', async () => {
      await seed();
      const without = await thePage('?period=all&group=pr');
      await send([spend('old', 3, { branch: 'b/10', category: 'unphased', sessionId: 's-old' })]);
      const html = await thePage('?period=all&group=pr');

      expect(splitColumns(without)).not.toContain('Unphased');
      expect(whereItWent(without).bar).not.toContain('Unphased');
      expect(splitColumns(html)[0]).toBe('Unphased');
      expect(whereItWent(html).bar.startsWith('Unphased $3.00, Outside the process $4.00')).toBe(true);
      const prPage = pullRequestFigures(await (await thePullRequest(10, '?period=all')).text());
      expect(prPage.categories[0]).toMatchObject({ name: 'Unphased', amount: '$3.00' });
    });

    it('the pull request page leaves Unphased out of a period that holds none', async () => {
      await seed();

      const figures = pullRequestFigures(await (await thePullRequest(10, '?period=all')).text());

      expect(figures.categories.map((c) => c.name)).not.toContain('Unphased');
    });
  });
});
