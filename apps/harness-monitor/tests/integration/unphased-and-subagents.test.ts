import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linked, pullRequest } from './github-support';
import {
  agentLines,
  costRows,
  emptyTheDatabase,
  runTheDailyJob,
  send,
  spend,
  theExport,
  thePage,
  thePullRequest,
  totals,
  usage,
  whereItWent,
  withPrices,
} from './support';

beforeEach(async () => {
  await emptyTheDatabase();
  await withPrices();
});
afterEach(() => vi.restoreAllMocks());

const BEFORE = '2026-09-20T23:59:59Z';
const AFTER = '2026-09-21T00:00:01Z';

/** The categories the page's bar names with dollars above zero. */
const spent = async (query: string) =>
  whereItWent(await thePage(query)).bar.split(', ').filter((part) => !part.endsWith('$0.00'));

describe('Harness Monitor', () => {
  describe('a Building request from before phase marks existed is Unphased', () => {
    it.each([
      { situation: 'Building on 20 Sep', category: 'building', time: BEFORE, shown: 'Unphased $4.00' },
      { situation: 'Building on 21 Sep', category: 'building', time: AFTER, shown: 'Building $4.00' },
      { situation: 'Scoping on 20 Sep', category: 'scoping-planning', time: BEFORE, shown: 'Scoping & planning $4.00' },
      { situation: 'stored as Unphased', category: 'unphased', time: BEFORE, shown: 'Unphased $4.00' },
    ])('$situation counts as $shown on the costs page', async ({ category, time, shown }) => {
      await send([spend('r', 4, { category, time })]);

      expect(await spent('?period=all')).toEqual([shown]);
    });

    it('the Unphased filter, the export and the pull request page all count it, and Building does not', async () => {
      await send([spend('old', 4, { time: BEFORE, sessionId: 's-old' }), spend('new', 2, { time: AFTER, sessionId: 's-new' })]);
      await linked(pullRequest({ number: 5, headRefName: 'claude/build-1' }));

      const unphasedRows = costRows(await thePage('?period=all&category=unphased'));
      expect(unphasedRows.map((r) => r.total)).toEqual(['$4.00']);
      expect(costRows(await thePage('?period=all&category=building')).map((r) => r.total)).toEqual(['$2.00']);

      const exported = await theExport('?period=all');
      expect(exported.rows.map((r) => [r[1], r[6]])).toEqual([
        ['s-old', 'unphased'],
        ['s-new', 'building'],
      ]);
      expect((await theExport('?period=all&category=unphased')).rows.map((r) => r[1])).toEqual(['s-old']);

      const prPage = await (await thePullRequest(5, '?period=all')).text();
      expect(prPage).toContain('Unphased');
      expect(await (await thePullRequest(5, '?period=all&category=unphased')).text()).toContain('id="pr-total">$4.00');
    });

    it('totals stored before the rule existed read the same, and the nightly rebuild writes what the rows write', async () => {
      await send([spend('old', 4, { time: BEFORE }), spend('new', 2, { time: AFTER })]);
      const written = await totals();
      // A totals row from a deployment that predates the rule: Building, on a day before it.
      await env.DB.prepare("UPDATE daily_totals SET category = 'building'").run();
      await env.DB.prepare("UPDATE daily_split_totals SET category = 'building'").run();

      expect(await spent('?period=all')).toEqual(['Unphased $4.00', 'Building $2.00']);

      await runTheDailyJob();

      expect(await totals()).toEqual(written);
      expect(await spent('?period=all')).toEqual(['Unphased $4.00', 'Building $2.00']);
      expect(written.map((t) => [t.day, t.category])).toEqual([
        ['2026-09-20', 'unphased'],
        ['2026-09-21', 'building'],
      ]);
    });
  });

  describe('a row may name its subagent, and only a subagent', () => {
    it('stores a subagent request with its type and id, and an old-style request with neither', async () => {
      const response = await send([
        usage('main'),
        usage('sub', { subagent: true, subagentType: 'Explore', subagentId: 'agent-7' }),
        usage('sub-old', { subagent: true }),
        usage('phaseless', { category: 'unphased' }),
      ]);

      expect(response.status).toBe(200);
      const { results } = await env.DB.prepare(
        'SELECT request_id AS id, category, subagent, subagent_type AS type, subagent_id AS sid FROM usage_requests ORDER BY request_id',
      ).all();
      expect(results).toEqual([
        { id: 'main', category: 'building', subagent: 0, type: null, sid: null },
        { id: 'phaseless', category: 'unphased', subagent: 0, type: null, sid: null },
        { id: 'sub', category: 'building', subagent: 1, type: 'Explore', sid: 'agent-7' },
        { id: 'sub-old', category: 'building', subagent: 1, type: null, sid: null },
      ]);
    });

    it('refuses a type on a main-agent request, naming the field, and stores nothing', async () => {
      const response = await send([usage('ok'), usage('bad', { subagentType: 'Explore' })]);

      expect(response.status).toBe(400);
      expect(await response.text()).toContain('subagentType');
      const { results } = await env.DB.prepare('SELECT request_id FROM usage_requests').all();
      expect(results).toEqual([]);
    });
  });

  describe("a pull request's page draws each session as its main agent with its subagents beneath", () => {
    const seed = async () => {
      await send([
        spend('m1', 2, { sessionId: 's1' }),
        spend('e1', 5, { sessionId: 's1', subagent: true, subagentType: 'Explore', subagentId: 'ex-1' }),
        spend('g1', 1, { sessionId: 's1', subagent: true, subagentType: 'general-purpose', subagentId: 'gp-1', category: 'after-push' }),
        spend('o1', 1, { sessionId: 's1', subagent: true }),
        // An id with no type still joins the one untyped line.
        spend('o2', 1, { sessionId: 's1', subagent: true, subagentId: 'lost-1' }),
        spend('solo', 3, { sessionId: 's2' }),
      ]);
      await linked(pullRequest({ number: 5, headRefName: 'claude/build-1' }));
    };
    const html = async (query = '?period=all') => (await thePullRequest(5, query)).text();

    it('lists the main agent first, then the subagents dearest first, each with its type, id and share', async () => {
      await seed();

      const lines = agentLines(await html()).slice(0, 5);

      expect(lines.map((l) => [l.kind, l.indented, l.name, l.requests, l.cost, l.share])).toEqual([
        ['main', false, 'Main agent', '1', '$2.00', '20%'],
        ['subagent', true, 'Explore ex-1', '1', '$5.00', '50%'],
        ['subagent', true, 'type not recorded', '2', '$2.00', '20%'],
        ['subagent', true, 'general-purpose gp-1', '1', '$1.00', '10%'],
        ['main', false, 'Main agent', '1', '$3.00', '100%'],
      ]);
      expect(lines[1]).toMatchObject({ models: 'claude-sonnet-5', tokens: '2.5 M' });
    });

    it('a session with no subagents is its main agent only', async () => {
      await seed();

      const lines = agentLines(await html());

      expect(lines.slice(4).map((l) => l.kind)).toEqual(['main']);
    });

    it('with a category chosen, the agent lines hold only that category', async () => {
      await seed();

      const lines = agentLines(await html('?period=all&category=after-push'));

      expect(lines.map((l) => [l.name, l.cost, l.share])).toEqual([['general-purpose gp-1', '$1.00', '100%']]);
    });
  });
});
