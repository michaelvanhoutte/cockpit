import { beforeEach, describe, expect, it } from 'vitest';
import { linked, pullRequest } from './github-support';
import { costRows, emptyTheDatabase, send, spend, theExport, thePage, whereItWent, withPrices } from './support';

beforeEach(async () => {
  await emptyTheDatabase();
  await withPrices();
});

/** The prices of the recorded list: claude-sonnet-5 is $2 per million input tokens, claude-opus-4-8 $5. */
const SONNET = 'claude-sonnet-5';
const OPUS = 'claude-opus-4-8';
/** A request costing `dollars` on claude-opus-4-8. */
const onOpus = (id: string, dollars: number, over: Record<string, unknown> = {}) =>
  spend(id, dollars, { model: OPUS, inputTokens: dollars * 200_000, ...over });

const split = async (query: string) => {
  const html = await thePage(`?period=all&${query}`);
  return { html, rows: costRows(html), bar: whereItWent(html) };
};

describe('Harness Monitor', () => {
  describe('the colouring decides what the bar, its legend and each row’s bar and hover show', () => {
    it('by model, a pull request on two models has a segment for each, and its hover names both', async () => {
      await send([spend('a', 3, { branch: 'b/10' }), onOpus('b', 2, { branch: 'b/10' }), spend('c', 1, { branch: 'b/11' })]);
      await linked(
        pullRequest({ number: 10, title: 'Two models', headRefName: 'b/10' }),
        pullRequest({ number: 11, title: 'One model', headRefName: 'b/11' }),
      );

      const { rows, bar } = await split('split=model');

      expect(rows.map((r) => [r.label, r.total, r.colours, r.segments])).toEqual([
        ['#10 Two models', '$5.00', `${SONNET} $3.00 · ${OPUS} $2.00`, 2],
        ['#11 One model', '$1.00', `${SONNET} $1.00`, 1],
      ]);
      expect(bar).toEqual({ heading: "Where the period's $6.00 went, by model", bar: `${SONNET} $4.00, ${OPUS} $2.00` });
    });

    it("by where, requests from engineers' machines, from cloud sessions and from Actions each have their own colour", async () => {
      await send([
        spend('a', 3, { branch: 'b/10', ranWhere: 'local' }),
        spend('b', 1, { branch: 'b/10', ranWhere: 'actions', category: 'ci-reviews' }),
        spend('c', 2, { branch: 'b/10', ranWhere: 'cloud' }),
      ]);
      await linked(pullRequest({ number: 10, title: 'Everywhere', headRefName: 'b/10' }));

      const { rows, bar } = await split('split=where');

      expect(rows.map((r) => [r.total, r.colours])).toEqual([['$6.00', "Engineers' machines $3.00 · Cloud sessions $2.00 · CI (GitHub Actions) $1.00"]]);
      expect(bar.bar).toBe("Engineers' machines $3.00, Cloud sessions $2.00, CI (GitHub Actions) $1.00");
    });

    it('by outcome, merged, open, closed, an unlinked branch and main each have their own colour', async () => {
      await send([
        spend('m', 5, { branch: 'b/merged' }),
        spend('o', 4, { branch: 'b/open' }),
        spend('c', 3, { branch: 'b/closed' }),
        spend('u', 2, { branch: 'b/unlinked' }),
        spend('n', 1, { branch: 'main' }),
      ]);
      await linked(
        pullRequest({ number: 1, title: 'Merged', headRefName: 'b/merged', state: 'MERGED', mergedAt: '2026-03-02T10:00:00Z' }),
        pullRequest({ number: 2, title: 'Open', headRefName: 'b/open', state: 'OPEN', mergedAt: null }),
        pullRequest({ number: 3, title: 'Closed', headRefName: 'b/closed', state: 'CLOSED', mergedAt: null }),
      );

      const byPullRequest = await split('split=outcome&sort=total');
      const byDay = await split('split=outcome&group=day');

      expect(byPullRequest.rows.map((r) => [r.label, r.colours])).toEqual([
        ['#1 Merged', 'Merged $5.00'],
        ['#2 Open', 'Still open $4.00'],
        ['#3 Closed', 'Closed unmerged $3.00'],
        ['b/unlinked', 'No pull request $2.00'],
        ['main', 'On main $1.00'],
      ]);
      // A by-day question has no branch of its own, and still places each request by its pull request.
      expect(byDay.rows.map((r) => [r.label, r.colours])).toEqual([['1 Oct 2026', 'Merged $5.00 · Still open $4.00 · Closed unmerged $3.00 · No pull request $2.00 · On main $1.00']]);
      expect(byDay.bar.bar).toBe('Merged $5.00, Still open $4.00, Closed unmerged $3.00, No pull request $2.00, On main $1.00');
    });

    it('by phase, which is the default, the colours are the phases, Unphased only where the period holds some', async () => {
      await send([
        spend('a', 3, { branch: 'b/10', category: 'building' }),
        spend('b', 1, { branch: 'b/10', category: 'after-push' }),
        // Building from before phase marks existed counts as Unphased.
        spend('c', 2, { branch: 'b/10', category: 'building', time: '2026-09-20T12:00:00Z' }),
      ]);
      await linked(pullRequest({ number: 10, title: 'Phases', headRefName: 'b/10' }));

      const asked = await split('split=phase');
      const unasked = await split('');

      expect(asked.rows.map((r) => r.colours)).toEqual(['Unphased $2.00 · Building $3.00 · After push $1.00']);
      expect(unasked.rows).toEqual(asked.rows);
      expect(unasked.bar).toEqual(asked.bar);
    });
  });

  describe('a catch-all row keeps every number and its total but draws no bar and has nothing to hover', () => {
    beforeEach(async () => {
      await send([
        spend('none', 2, { branch: null, category: 'building' }),
        spend('stray', 1, { branch: 'b/unlinked', category: 'building' }),
        spend('named', 3, { branch: 'b/10', category: 'building' }),
      ]);
      await linked(pullRequest({ number: 10, title: 'Nobody', headRefName: 'b/10', author: null, closingIssuesReferences: { nodes: [] } }));
    });

    it.each([
      { situation: 'an issue grouping, requests on no pull request', group: 'issue', label: 'Unattributed', total: '$3.00' },
      { situation: 'an issue grouping, a pull request closing no issue', group: 'issue', label: 'No issue', total: '$3.00' },
      { situation: 'an engineer grouping, requests on no pull request', group: 'engineer', label: 'Unattributed', total: '$3.00' },
      { situation: 'an engineer grouping, a pull request with no author', group: 'engineer', label: 'unknown', total: '$3.00' },
      { situation: 'a pull request grouping, requests on no branch', group: 'pr', label: 'No branch', total: '$2.00' },
    ])('$situation', async ({ group, label, total }) => {
      const row = costRows(await thePage(`?period=all&group=${group}`)).find((r) => r.label === label)!;

      expect(row.segments).toBe(0);
      expect(row.colours).toBe('');
      expect(row.total).toBe(total);
    });
  });

  describe('the other rows scale to the largest row that draws a bar', () => {
    it('a catch-all larger than every named row leaves the largest named row full width', async () => {
      await send([
        spend('big', 10, { branch: null, category: 'building' }),
        spend('a', 3, { branch: 'b/10', category: 'building' }),
        spend('b', 1.5, { branch: 'b/11', category: 'after-push' }),
      ]);
      await linked(
        pullRequest({ number: 10, title: 'Largest', headRefName: 'b/10' }),
        pullRequest({ number: 11, title: 'Second', headRefName: 'b/11' }),
      );

      const rows = costRows(await thePage('?period=all&group=pr&sort=total'));

      expect(rows.map((r) => [r.label, r.widths])).toEqual([
        ['No branch', []],
        ['#10 Largest', [100]],
        ['#11 Second', [50]],
      ]);
    });

    it('with only catch-all rows on the page there are no bars, and the page still renders', async () => {
      await send([spend('none', 2, { branch: null, category: 'building' })]);

      const html = await thePage('?period=all&group=pr');

      expect(costRows(html).map((r) => [r.label, r.total, r.widths])).toEqual([['No branch', '$2.00', []]]);
      expect(whereItWent(html).heading).toBe("Where the period's $2.00 went, by phase");
    });
  });

  describe('a named branch that no pull request names is not a catch-all', () => {
    it('in the pull request grouping it keeps its bar, sized against the largest row', async () => {
      await send([spend('solo', 2, { branch: 'b/solo', category: 'building' }), spend('a', 1, { branch: 'b/10', category: 'building' })]);
      await linked(pullRequest({ number: 10, title: 'Named', headRefName: 'b/10' }));

      const rows = costRows(await thePage('?period=all&group=pr&sort=total'));

      expect(rows.map((r) => [r.label, r.widths])).toEqual([
        ['b/solo', [100]],
        ['#10 Named', [50]],
      ]);
    });
  });

  describe('the Model and Requests filters keep only matching cost, everywhere on the page', () => {
    /** Pull request 10: $3 and $1 of Sonnet (the second by a subagent) and $2 of Opus. Pull request 11: $4 of Sonnet. */
    beforeEach(async () => {
      await send([
        spend('a', 3, { branch: 'b/10', sessionId: 'alice' }),
        spend('b', 1, { branch: 'b/10', sessionId: 'alice', subagent: true }),
        onOpus('c', 2, { branch: 'b/10', sessionId: 'alice' }),
        spend('d', 4, { branch: 'b/11', sessionId: 'bob' }),
      ]);
      await linked(
        pullRequest({ number: 10, title: 'First', headRefName: 'b/10', author: { login: 'alice' } }),
        pullRequest({ number: 11, title: 'Second', headRefName: 'b/11', author: { login: 'bob' } }),
      );
    });

    const figures = async (query: string) => {
      const { html, rows, bar } = await split(query);
      return { rows: rows.map((r) => [r.label, r.total]), heading: bar.heading, html };
    };

    it('a model keeps only its cost in each row and in the total', async () => {
      const { rows, heading } = await figures('model=claude-opus-4-8');

      expect(rows).toEqual([['#10 First', '$2.00']]);
      expect(heading).toBe("Where the period's $2.00 went, by phase");
    });

    it('main session leaves out the subagents, and subagents leaves out the main agent', async () => {
      expect((await figures('who=main')).rows).toEqual([['#10 First', '$5.00'], ['#11 Second', '$4.00']]);
      expect((await figures('who=subagents')).rows).toEqual([['#10 First', '$1.00']]);
      expect((await figures('who=subagents')).heading).toBe("Where the period's $1.00 went, by phase");
    });

    it('a model and an engineer together keep only what matches both', async () => {
      expect((await figures('model=claude-sonnet-5&engineer=alice')).rows).toEqual([['#10 First', '$4.00']]);
      expect((await figures('model=claude-sonnet-5&engineer=bob')).rows).toEqual([['#11 Second', '$4.00']]);
      expect((await figures('model=claude-opus-4-8&engineer=bob')).rows).toEqual([]);
    });

    it('the filters narrow the colouring too, and the page offers every model on record', async () => {
      const { bar, html } = await split('split=model&who=subagents');

      expect(bar.bar).toBe(`${SONNET} $1.00`);
      expect(html).toContain(`<option value="${OPUS}">${OPUS}</option>`);
      expect(html).toContain('<option value="subagents" selected>Subagents</option>');
    });

    it('the export keeps the same requests as the page', async () => {
      const everyone = await theExport('?period=all');
      const opus = await theExport(`?period=all&model=${OPUS}`);
      const subagents = await theExport('?period=all&who=subagents');

      expect([everyone.rows.length, opus.rows.length, subagents.rows.length]).toEqual([4, 1, 1]);
      expect(opus.rows[0]![everyone.header.indexOf('model')]).toBe(OPUS);
    });
  });
});
