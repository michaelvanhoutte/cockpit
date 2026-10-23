import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linked, pullRequest } from './github-support';
import { costRows, emptyTheDatabase, send, spend, tableHeads, theBarePage, theSentence, withPrices } from './support';

beforeEach(async () => {
  await emptyTheDatabase();
  await withPrices();
  await send([
    spend('a', 3, { branch: 'b/10', model: 'claude-sonnet-5' }),
    spend('b', 2, { branch: 'b/10', model: 'claude-opus-4-8', inputTokens: 400_000 }),
    spend('c', 1, { branch: 'b/11', time: '2026-10-02T10:00:00Z' }),
  ]);
  await linked(
    pullRequest({ number: 10, title: 'Two models', headRefName: 'b/10', author: { login: 'alice' } }),
    pullRequest({ number: 11, title: 'One model', headRefName: 'b/11', author: { login: 'bob' } }),
  );
});
afterEach(() => vi.restoreAllMocks());

const page = (query: string) => theBarePage(`?${query}`);

describe('Harness Monitor', () => {
  describe('the sentence says what the page shows, and offers only what it can', () => {
    it('the bare address reads each day, coloured by phase, over the last 30 days, with no filter holding a value', async () => {
      const { text, choices } = theSentence(await page(''));

      expect(text).toBe('Show cost for [each day] coloured by [phase] over [the last 30 days]');
      expect(choices.group!.offered).toEqual(['each day', 'each pull request', 'each issue', 'each engineer', 'each phase']);
      expect(choices.split!.offered).toEqual(['phase', 'engineer', 'model', 'where it ran', 'outcome']);
      expect(choices.period!.offered).toEqual(['the last 7 days', 'the last 30 days', 'the last 90 days', 'all time']);
      expect(Object.values(choices).filter((c) => c.held)).toEqual([]);
      expect(choices.split!.disabled).toEqual([]);
    });

    it.each([
      { situation: 'each engineer', query: 'group=engineer', disabled: 'engineer', text: 'Show cost for [each engineer] coloured by [phase] over [the last 30 days]' },
      { situation: 'each phase', query: 'group=category', disabled: 'phase', text: 'Show cost for [each phase] coloured by [engineer] over [the last 30 days]' },
    ])('$situation offers coloured by $disabled but not for the choosing', async ({ query, disabled, text }) => {
      const sentence = theSentence(await page(query));

      expect(sentence.text).toBe(text);
      expect(sentence.choices.split!.disabled).toEqual([disabled]);
      expect(sentence.choices.split!.offered).toContain(disabled);
    });

    it('a model chosen is marked as holding a value, and every choice of the sentence is in the one form that keeps it', async () => {
      const html = await page('group=pr&model=claude-opus-4-8&split=model&period=7d');
      const { choices, text } = theSentence(html);

      expect(choices.model).toMatchObject({ chosen: 'claude-opus-4-8', held: true });
      expect(text).toBe('Show cost for [each pull request] coloured by [model] over [the last 7 days]');
      expect(Object.keys(choices)).toEqual(['group', 'split', 'period', 'engineer', 'category', 'model', 'who']);
      // One form holds the sentence and the filters, so a changed word submits the filters with it.
      expect(html.match(/<form /g)).toHaveLength(1);
      expect(/<form class="sentence-form".*?name="group".*?name="model".*?<\/form>/s.test(html)).toBe(true);
    });

    it('Export CSV is on the band, after Only, and carries the filters', async () => {
      const html = await page('model=claude-opus-4-8');

      expect(/<div class="only"><span>Only<\/span>.*Export CSV<\/a><\/div>/s.test(html)).toBe(true);
      expect(html).toContain('href="/export.csv?model=claude-opus-4-8"');
    });
  });

  describe('the page reads in the sentence’s order, and the change card is gone', () => {
    /** Where each part of the page starts, in the order it is read. */
    const order = (html: string) =>
      (
        [
          ['where it went', 'id="where"'],
          ['cost per day', 'id="perday"'],
          ['tokens per day', 'id="tokensperday"'],
          ['the table', '<table class="costs">'],
          ['the trends', 'id="trends"'],
        ] as const
      )
        .map(([name, marker]) => [name, html.indexOf(marker)] as const)
        .filter(([, at]) => at >= 0)
        .sort((a, b) => a[1] - b[1])
        .map(([name]) => name);

    it('each day: where it went, Cost per day, Tokens per day, the table, then the trends, whose band says what they follow', async () => {
      const html = await page('');

      expect(order(html)).toEqual(['where it went', 'cost per day', 'tokens per day', 'the table', 'the trends']);
      expect(/<h2 id="where">Where the period&rsquo;s \$6\.00 went, by phase<\/h2>/.test(html)).toBe(true);
      expect(/<h2 id="trends">Is the harness getting more expensive\?<\/h2><span class="aside">Not affected by &ldquo;coloured by&rdquo;: these follow the period and the &ldquo;Only&rdquo; filters\.<\/span>/.test(html)).toBe(true);
    });

    it('each pull request: where it went, then the table, with no per-day charts and no trends', async () => {
      const html = await page('group=pr');

      expect(order(html)).toEqual(['where it went', 'the table']);
    });

    it.each(['', 'group=pr', 'group=issue', 'group=engineer', 'group=category', 'period=all', 'period=7d'])('the address "%s" has no change on the previous period', async (query) => {
      const html = await page(query);

      expect(html).not.toContain('Change on the previous period');
      expect(html).not.toContain('data-card');
      expect(html).not.toContain('data-driver');
    });

    it('the heading names the colouring chosen', async () => {
      for (const [split, words] of [['engineer', 'by engineer'], ['model', 'by model'], ['where', 'by where it ran'], ['outcome', 'by outcome']] as const) {
        expect(await page(`split=${split}`)).toContain(`went, ${words}</h2>`);
      }
    });
  });

  describe('the table carries only what explains cost', () => {
    it('each pull request, coloured by model: no column per model, and the bar’s column says what colours it', async () => {
      const html = await page('group=pr&split=model&period=all');

      expect(tableHeads(html)).toEqual(['Pull request', 'Engineer', 'Merged', 'Lines', 'Coloured by model', 'Total']);
    });

    it('a pull request on two models has a bar whose hover names each model with its dollars', async () => {
      const rows = costRows(await page('group=pr&split=model&period=all&sort=total'));

      expect(rows.map((r) => [r.label, r.colours])).toEqual([
        ['#10 Two models', 'claude-sonnet-5 $3.00 · claude-opus-4-8 $2.00'],
        ['#11 One model', 'claude-sonnet-5 $1.00'],
      ]);
    });

    it.each([
      { situation: 'each day', query: 'group=day', heads: ['Day', 'Coloured by phase', 'Total', 'Input', 'Output', 'Cache write', 'Cache read'] },
      { situation: 'each issue', query: 'group=issue', heads: ['Issue', 'Pull requests', 'Coloured by phase', 'Total'] },
      { situation: 'each engineer, which cannot be coloured by engineer', query: 'group=engineer&split=engineer', heads: ['Engineer', 'Pull requests', 'Coloured by phase', 'Total'] },
      { situation: 'each phase, which cannot be coloured by phase', query: 'group=category&split=phase', heads: ['Category', 'Coloured by engineer', 'Total'] },
    ])('$situation', async ({ query, heads }) => {
      expect(tableHeads(await page(`${query}&period=all`))).toEqual(heads);
    });

    it('a pull request row loses Open → merged, CI rounds, Rounds and Findings', async () => {
      const html = await page('group=pr&period=all');

      for (const gone of ['Open → merged', 'CI rounds', 'Rounds', 'Findings']) expect(tableHeads(html)).not.toContain(gone);
    });
  });
});
