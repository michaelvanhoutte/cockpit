import { createExecutionContext, env, SELF, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../../src/worker';
import { area, kase, model, rule, rules } from '../fixtures/tests-model';
import { emptyTheDatabase, merged, sendTestsModel, theSentence } from './support';
import { coloursOf, GREY, segments, slot, swatches } from './series-colours';

beforeEach(emptyTheDatabase);

const API_UNIT = 'apps/api/tests/unit/capture.test.ts';
const API_INT = 'apps/api/tests/integration/capture.test.ts';
const E2E = 'tests/e2e/capture.test.ts';
const WEB = 'apps/web/tests/unit/offline.test.ts';

/** A rule of four cases and one not written yet, each with lines around it in the Inbox's own document. */
const FOUR_CASES = rule(
  'A captured thought lands in the inbox',
  'L2',
  API_INT,
  20,
  [kase('a note', API_INT, 22), kase('a link', API_INT, 30), kase('a photo', API_INT, 38), kase('a voice memo', API_INT, 46)],
  [kase('a forwarded email', API_INT, 54)],
);
const around = (line: number, text: string) => [
  { line: line - 1, text: '    // above' },
  { line, text },
  { line: line + 1, text: '    // below' },
];
const INBOX_LINES = {
  [`${API_INT}:20`]: around(20, "  describe('A captured thought lands in the inbox', () => {"),
  [`${API_INT}:22`]: around(22, "    it('a note', async () => {"),
  [`${API_INT}:30`]: around(30, "    it('a link', async () => {"),
  [`${API_INT}:38`]: around(38, "    it('a photo', async () => {"),
  [`${API_INT}:46`]: around(46, "    it('a voice memo', async () => {"),
  [`${API_INT}:54`]: around(54, "    it.todo('a forwarded email');"),
};

/** Inbox: 2 L1, 1 L2, 1 F3 of its own; Capture inside it: 2 F3. Offline holds a file nothing runs. */
const TREE = [
  area(
    'Workspaces',
    [],
    [
      area('Inbox', [...rules(2, 'L1', API_UNIT), FOUR_CASES, ...rules(1, 'F3', E2E)], [area('Capture', rules(2, 'F3', E2E))]),
      area('Panels'),
    ],
  ),
  area('Offline', rules(1, 'L1', WEB), [], { filesNothingRuns: [{ file: 'apps/web/src/offline.ts', line: 1 }, { file: 'apps/api/src/sync.ts', line: 1 }] }),
];
const SNAPSHOT = model(TREE);

const thePage = async (query = '', init: RequestInit = {}) => {
  const response = await SELF.fetch(`https://monitor.test/tests${query}`, init);
  expect(response.status).toBe(200);
  return response.text();
};

const plain = (html: string) => html.replace(/<style>.*?<\/style>/s, '').replace(/<[^>]+>/g, ' ').replace(/&[#\w]+;/g, ' ').replace(/\s+/g, ' ').trim();
const sectionOf = (html: string, id: string) => new RegExp(`<section[^>]*aria-labelledby="${id}".*?</section>`, 's').exec(html)?.[0] ?? '';
const hasSection = (html: string, id: string) => sectionOf(html, id) !== '';
/** A table row of a section, as markup, by the text its first cell starts with. */
const rowOf = (html: string, id: string, name: string) => [...sectionOf(html, id).matchAll(/<tr[ >].*?<\/tr>/gs)].map((m) => m[0]).find((row) => plain(row).startsWith(name)) ?? '';
const cellsOf = (row: string) => [...row.matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((m) => m[1]!);
/** The cell a level's count sits in on the Concept area tab: after the area's name and its bar, one per level in testing-strategy's order. */
const levelCell = (row: string, level: string) => cellsOf(row)[2 + ['L1', 'L2', 'L3', 'F1', 'F2', 'F3', 'Contract'].indexOf(level)]!;
const hrefOf = (markup: string) => /href="([^"]*)"/.exec(markup)?.[1]?.replace(/&#38;/g, '&');

describe('Harness Monitor', () => {
  describe("main's tests are a page, and the same address answers JSON to a request that asks", () => {
    it('opens as a page from its own tab in the top bar, between Test selection and CI stability', async () => {
      await sendTestsModel(SNAPSHOT);

      const html = await thePage();

      expect(html).toContain('<a href="/tests" aria-current="page">Tests</a>');
      expect(plain(html.match(/<nav class="pages".*?<\/nav>/s)![0])).toBe('Claude Code costs Cockpit s Claude calls Cycle time Test selection Tests CI stability');
      expect(html.match(/<h1\b/g) ?? []).toHaveLength(0);
      expect(html).toContain('abc1234');
    });

    it.each([
      { situation: 'format=json in the address', query: '?format=json', headers: {} },
      { situation: 'an Accept header for JSON', query: '', headers: { accept: 'application/json' } },
    ])('answers the tree as JSON for $situation', async ({ query, headers }) => {
      await sendTestsModel(SNAPSHOT);

      const response = await SELF.fetch(`https://monitor.test/tests${query}`, { headers });

      expect(response.headers.get('content-type')).toBe('application/json');
      expect(await response.json()).toMatchObject({ commit: 'abc1234', coverageAvailable: false });
    });

    it('answers a browser, which accepts HTML first, with the page', async () => {
      await sendTestsModel(SNAPSHOT);

      const response = await SELF.fetch('https://monitor.test/tests', { headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } });

      expect(response.headers.get('content-type')).toContain('text/html');
    });
  });

  describe('a count opens exactly the tests behind it, area by area, and leaves the filters as they were', () => {
    it("Inbox's F3 count of 3 links to those 3 rules, and the Level filter is not changed by following it", async () => {
      await sendTestsModel(SNAPSHOT);
      const inbox = rowOf(await thePage(), 'areas', 'Inbox');
      expect(plain(levelCell(inbox, 'F3'))).toBe('1 (3)');
      const href = hrefOf(levelCell(inbox, 'F3'))!;
      expect(href).toBe('/tests?tests=Inbox%7EF3%7E#tests');

      const html = await thePage(href.slice('/tests'.length).replace('#tests', ''));

      const opened = sectionOf(html, 'tests');
      expect(plain(opened)).toContain('Tests: 3 rules in Inbox and inside it · F3 · End-to-end');
      expect(plain(opened)).toContain('Workspaces › Inbox 1 rule');
      expect(plain(opened)).toContain('Workspaces › Inbox › Capture 2 rules');
      expect([...opened.matchAll(/<td class="first"><a href="[^"]*rule=/g)]).toHaveLength(3);
      expect(theSentence(html).choices.level).toMatchObject({ chosen: 'All levels', held: false });
    });

    it('a count followed while Level is L1 opens the tests it names, and Level stays L1', async () => {
      await sendTestsModel(SNAPSHOT);

      const html = await thePage('?level=L1&tests=Inbox%7EF3%7E');

      expect(plain(sectionOf(html, 'tests'))).toContain('Tests: 3 rules in Inbox and inside it · F3 · End-to-end');
      expect(theSentence(html).choices.level).toMatchObject({ chosen: 'L1 · Unit', held: true });
    });

    it("a package column's count on Testing level opens that level's rules in that package", async () => {
      await sendTestsModel(SNAPSHOT);
      const html = await thePage('?group=level');
      const l1 = cellsOf(rowOf(html, 'by-level', 'L1 · Unit'));
      // After the level's name and its bar, the packages seen: apps/api, apps/web, tests/e2e.
      const api = hrefOf(l1[2]!)!;
      expect(api).toBe('/tests?group=level&tests=%7EL1%7Eapi#tests');

      const opened = await thePage(api.slice('/tests'.length).replace('#tests', ''));

      expect(plain(sectionOf(opened, 'tests'))).toContain('Tests: 2 rules · L1 · Unit · apps/api');
    });

    it('a count of 0 is not a link', async () => {
      await sendTestsModel(SNAPSHOT);

      const capture = rowOf(await thePage(), 'areas', 'Capture');

      expect(levelCell(capture, 'L1')).toBe('<span class="faint">0</span>');
      expect(levelCell(capture, 'F3')).toContain('<a class="count"');
    });
  });

  describe('a rule opens its cases with the source lines around each', () => {
    it('a rule of four cases and one not written yet lists all five, each with its lines, and marks the one not written', async () => {
      await sendTestsModel(SNAPSHOT, { Inbox: INBOX_LINES });

      const html = await thePage(`?rule=${encodeURIComponent(`${API_INT}:20`)}`);

      const cases = sectionOf(html, 'cases');
      expect([...cases.matchAll(/<li>/g)]).toHaveLength(5);
      expect(plain(cases)).toContain('4 cases');
      expect(plain(cases)).toContain('a voice memo');
      // The case's own line is marked, with the line above it.
      expect(cases).toContain('<span class="hit"><b>46</b>    it(&#39;a voice memo&#39;, async () =&#62; {</span>');
      expect(cases).toContain('<span class=""><b>45</b>    // above</span>');
      expect(sectionOf(html, 'rule')).toContain('<span class="hit"><b>20</b>  describe(&#39;A captured thought lands in the inbox&#39;');
      const notWritten = [...cases.matchAll(/<li>(.*?)<\/li>/gs)].map((m) => m[1]!).filter((li) => li.includes('not written yet'));
      expect(notWritten).toHaveLength(1);
      expect(plain(notWritten[0]!)).toContain('a forwarded email');
    });

    it('a case whose lines were not stored still says where it is', async () => {
      await sendTestsModel(SNAPSHOT, { Inbox: { [`${API_INT}:22`]: around(22, "    it('a note'") } });

      const cases = sectionOf(await thePage(`?rule=${encodeURIComponent(`${API_INT}:20`)}`), 'cases');

      expect(cases).toContain(`<div class="path"><a href="https://github.com/o/r/blob/abc1234/${API_INT}#L30"`);
    });

    it('a rule opened from the tests behind a count belongs to the page it came from', async () => {
      await sendTestsModel(SNAPSHOT, { Inbox: INBOX_LINES });
      const listed = sectionOf(await thePage('?tests=Inbox%7EL2%7E'), 'tests');

      const href = hrefOf(listed.match(/<td class="first"><a href="[^"]*"/)![0])!;
      const html = await thePage(href.slice('/tests'.length).replace('#tests', ''));

      expect(plain(sectionOf(html, 'rule'))).toContain('A captured thought lands in the inbox');
      expect(plain(sectionOf(html, 'rule'))).toContain('Workspaces › Inbox · apps/api');
    });
  });

  describe('Gaps lists every file nothing runs with the areas that own it, and branches nothing takes say unknown without coverage', () => {
    it('every file nothing runs is listed with the area that owns it, narrowed by Package', async () => {
      await sendTestsModel(SNAPSHOT);

      const all = sectionOf(await thePage('?group=gaps'), 'gap-files');
      const narrowed = sectionOf(await thePage('?group=gaps&package=api'), 'gap-files');

      expect(plain(all)).toContain('apps/web/src/offline.ts Offline apps/web');
      expect(plain(all)).toContain('apps/api/src/sync.ts Offline apps/api');
      expect(plain(narrowed)).toContain('apps/api/src/sync.ts');
      expect(plain(narrowed)).not.toContain('offline.ts');
    });

    it('a snapshot without coverage says branches nothing takes are unknown, never 0', async () => {
      await sendTestsModel(SNAPSHOT);

      const gaps = plain(sectionOf(await thePage('?group=gaps'), 'gap-branches'));
      const tiles = plain(await thePage());

      expect(gaps).toContain('Unknown, not zero');
      expect(tiles).toMatch(/Branches nothing takes unknown/);
      expect(cellsOf(rowOf(await thePage(), 'areas', 'Offline')).at(-1)).toBe('<span class="na">unknown</span>');
    });

    it('a snapshot with coverage counts the branches per file and lists their lines', async () => {
      const withCoverage = model(
        [area('Offline', rules(1, 'L1', WEB), [], { branchesNothingTakes: [{ file: 'apps/web/src/offline.ts', line: 7 }, { file: 'apps/web/src/offline.ts', line: 12 }] })],
        { coverageAvailable: true },
      );
      await sendTestsModel(withCoverage);

      const html = await thePage();
      const gaps = sectionOf(await thePage('?group=gaps'), 'gap-branches');

      expect(plain(html)).toMatch(/Branches nothing takes 2 branches no test takes/);
      expect(plain(cellsOf(rowOf(html, 'areas', 'Offline')).at(-1)!)).toBe('2');
      expect(plain(gaps)).toContain('apps/web/src/offline.ts 2 7 , 12 Offline');
      expect(gaps).toContain('/blob/abc1234/apps/web/src/offline.ts#L12"');
    });

    it('a file two areas both list is counted once, by the most either holds', async () => {
      const shared = [{ file: 'apps/web/src/offline.ts', line: 7 }, { file: 'apps/web/src/offline.ts', line: 12 }];
      await sendTestsModel(
        model([area('Offline', rules(1, 'L1', WEB), [], { branchesNothingTakes: shared }), area('Sync', rules(1, 'L1', WEB), [], { branchesNothingTakes: shared })], { coverageAvailable: true }),
      );

      const gaps = sectionOf(await thePage('?group=gaps'), 'gap-branches');

      expect(plain(gaps)).toContain('2 branches in 1 file');
      expect(plain(gaps)).toContain('apps/web/src/offline.ts 2 7 , 12 Offline , Sync');
    });

    it('a warning that tests drive the Worker over HTTP is drawn on Gaps with each test named', async () => {
      await sendTestsModel(model(TREE, { warnings: ['No import edge from: apps/api/tests/integration/a.test.ts, apps/api/tests/integration/b.test.ts.'] }));

      const html = await thePage('?group=gaps');

      expect(plain(html)).toContain('Some of these may be false positives. 2 tests drive the real Worker');
      expect(html).toContain('apps/api/tests/integration/b.test.ts');
    });
  });

  describe('tiles and overview panels are on Concept area only', () => {
    it.each([
      { tab: 'group=area', tiles: 5, where: true },
      { tab: 'group=level', tiles: 0, where: false },
      { tab: 'group=package', tiles: 0, where: false },
      { tab: 'group=gaps', tiles: 0, where: false },
    ])('$tab draws its tiles and overview panels: $where', async ({ tab, tiles, where }) => {
      await sendTestsModel(SNAPSHOT);

      const html = await thePage(`?${tab}`);

      expect(html.match(/<div class="tile /g) ?? []).toHaveLength(tiles);
      expect(hasSection(html, 'where')).toBe(where);
      expect(hasSection(html, 'worst')).toBe(where);
    });

    it('the tiles count the rules, cases and files nothing runs of the area drilled into', async () => {
      await sendTestsModel(SNAPSHOT);

      const tiles = plain((await thePage('?node=Inbox')).match(/<div class="tiles">.*?<\/div>\s*<div class="row">/s)![0]);

      expect(tiles).toContain('Rules 6 in Inbox and the 1 area inside it');
      expect(tiles).toContain('Cases 9 in 3 test files · 1 not written yet');
      expect(tiles).toContain('Files nothing runs 0');
    });
  });

  describe('Show keeps the areas asked for, with what holds them faint', () => {
    it('areas with no F3 rule keeps Panels and Offline, and draws Workspaces, which holds Panels, faint', async () => {
      await sendTestsModel(SNAPSHOT);

      const table = sectionOf(await thePage('?level=F3&show=empty'), 'areas');

      const rows = [...table.matchAll(/<tr class="(context)?"><td class="first">.*?<a href="[^"]*">(.*?)<\/a>/gs)].map((m) => [m[2], m[1] ?? 'kept']);
      expect(rows).toEqual([['Workspaces', 'context'], ['Panels', 'kept'], ['Offline', 'kept']]);
    });
  });

  describe('the tree is drilled through the address with a breadcrumb', () => {
    it("Capture's breadcrumb names the areas above it, each a link, and its own rules are listed", async () => {
      await sendTestsModel(SNAPSHOT);

      const html = await thePage('?node=Capture');

      const crumbs = html.match(/<nav class="crumbs".*?<\/nav>/s)![0];
      expect(plain(crumbs)).toBe('All areas › Workspaces › Inbox › Capture');
      expect(crumbs).toContain('<a href="/tests?node=Inbox">Inbox</a>');
      expect(plain(sectionOf(html, 'own-rules'))).toContain('Rules on Capture itself 2 rules');
    });

    it('an area the snapshot does not hold is the whole tree', async () => {
      await sendTestsModel(SNAPSHOT);

      const html = await thePage('?node=Nowhere&rule=nothing.test.ts%3A1');

      expect(plain(html.match(/<nav class="crumbs".*?<\/nav>/s)![0])).toBe('All areas');
      expect(hasSection(html, 'areas')).toBe(true);
    });
  });

  describe('a link naming an area the snapshot no longer holds opens nothing rather than everything', () => {
    it('a clicked count for a missing area shows no list of tests', async () => {
      await sendTestsModel(SNAPSHOT);

      const html = await thePage('?tests=GoneArea~L1~');

      expect(hasSection(html, 'tests')).toBe(false);
      expect(hasSection(html, 'areas')).toBe(true);
    });
  });

  describe('the sentence keeps the Count by choice', () => {
    it('changing a word of the sentence on another tab sends split along', async () => {
      await sendTestsModel(SNAPSHOT);

      const html = await thePage('?group=level&split=package');

      expect(html.match(/<form class="sentence-form".*?<\/form>/s)![0]).toContain('<input type="hidden" name="split" value="package">');
    });
  });

  describe('a view kept at the edge is the one the address asks for', () => {
    it('a rule opened and the bare page are two views, each its own', async () => {
      await sendTestsModel(SNAPSHOT);
      const cached = { ...env, PAGE_CACHE_SECONDS: '300' };
      const open = async (query: string) => {
        const ctx = createExecutionContext();
        const response = await worker.fetch(new Request(`https://monitor.test/tests${query}`), cached, ctx);
        await waitOnExecutionContext(ctx);
        return plain(await response.text());
      };

      const rule = await open(`?rule=${encodeURIComponent(`${API_INT}:20`)}`);
      const bare = await open('');

      expect(rule).toContain('a voice memo');
      expect(bare).not.toContain('a voice memo');
    });
  });

  describe('what a snapshot says is escaped', () => {
    it('a rule named with markup is drawn as text', async () => {
      await sendTestsModel(model([area('Offline', [rule('<img src=x onerror=alert(1)>', 'L1', WEB, 5)])]));

      const html = await thePage('?tests=Offline%7E%7E');

      expect(html).not.toContain('<img src=x');
      expect(html).toContain('&#60;img src=x onerror=alert(1)&#62;');
    });
  });

  describe('the sentence lists the open pull requests with tests shown, and picking one shows its tests', () => {
    /** The options of the sentence's first word that can be picked, and the one chosen; null where the sentence has only the plain word. */
    const picker = (html: string) => {
      const choice = theSentence(html).choices.pr;
      return choice === undefined ? null : { offered: choice.offered.filter((text) => !choice.disabled.includes(text)), chosen: choice.chosen };
    };
    const ofPullRequest = (commit: string, name: string) => model([area(name, rules(1, 'L1', API_UNIT))], { commit, commitUrl: `https://github.com/o/r/commit/${commit}` });

    it('with tests for main, 9001 and 9003, it offers main, 9003 and 9001, newest first, with main chosen', async () => {
      await sendTestsModel(SNAPSHOT);
      await sendTestsModel(ofPullRequest('def5678', 'Only on 9001'), {}, 'pr-9001');
      await sendTestsModel(ofPullRequest('fed8765', 'Only on 9003'), {}, 'pr-9003');

      expect(picker(await thePage())).toEqual({
        offered: ['main’s', '#9003', '#9001'],
        chosen: 'main’s',
      });
    });

    it("picking 9001 shows 9001's tree, names its commit, and keeps it on every link and filter", async () => {
      await sendTestsModel(SNAPSHOT);
      await sendTestsModel(ofPullRequest('def5678', 'Only on 9001'), {}, 'pr-9001');

      const html = await thePage('?pr=9001');

      expect(picker(html)?.chosen).toBe('#9001');
      expect(plain(html)).toContain('at def5678');
      expect(rowOf(html, 'areas', 'Only on 9001')).not.toBe('');
      expect(rowOf(html, 'areas', 'Inbox')).toBe('');
      expect(hrefOf(rowOf(html, 'areas', 'Only on 9001'))).toBe('/tests?node=Only+on+9001&pr=9001');
      expect(html.match(/<form class="sentence-form".*?<\/form>/s)![0]).toContain('<option value="9001" selected>');
    });

    it.each([
      { situation: 'a pull request with none', arrange: async () => {}, number: 9002 },
      {
        situation: 'a pull request linking has read as merged, before the next linking deletes its tests',
        arrange: async () => {
          await sendTestsModel(ofPullRequest('def5678', 'Only on 9001'), {}, 'pr-9001');
          await merged(9001, '2026-10-24T08:00:00Z', 120);
        },
        number: 9001,
      },
    ])('$situation, asked for in the address, says it has none, shows it chosen, and offers only main', async ({ arrange, number }) => {
      await sendTestsModel(SNAPSHOT);
      await arrange();

      const html = await thePage(`?pr=${number}`);

      expect(plain(sectionOf(html, 'nothing'))).toContain(`Pull request #${number} has no snapshot of its tests here.`);
      expect(picker(html)).toEqual({ offered: ['main’s'], chosen: `#${number}` });
    });

    it('a pull request with none keeps itself and the view asked for when new rows are chosen, and picking main’s still wins', async () => {
      await sendTestsModel(SNAPSHOT);

      const form = (await thePage('?pr=9002&node=Inbox&split=package')).match(/<form class="sentence-form".*?<\/form>/s)![0];
      // Its own option is disabled, so the form never sends it; the hidden field after the select does, and an empty main’s before it is read first.
      const select = form.indexOf('name="pr"');
      const kept = form.indexOf('<input type="hidden" name="pr" value="9002">');

      expect(select).toBeGreaterThan(-1);
      expect(kept).toBeGreaterThan(select);
      expect(form).toContain('<input type="hidden" name="node" value="Inbox">');
      expect(form).toContain('<input type="hidden" name="split" value="package">');
    });

    it("with only main's tests, the sentence says main's as words", async () => {
      await sendTestsModel(SNAPSHOT);

      const html = await thePage();

      expect(picker(html)).toBeNull();
      expect(theSentence(html).text).toBe('Show main’s tests for [each concept area] counted by [level]');
    });
  });

  describe("what a pull request's tests and title say is drawn as text, never run", () => {
    it.each([
      { situation: 'a rule statement containing a script', statement: '<script>alert(1)</script>', title: 'Fine', written: '&#60;script&#62;alert(1)&#60;/script&#62;' },
      { situation: 'a title containing a script', statement: 'A rule', title: '<script>alert(2)</script>', written: '#9001 · &#60;script&#62;alert(2)&#60;/script&#62;' },
    ])('$situation is shown as written', async ({ statement, title, written }) => {
      await sendTestsModel(model([area('Offline', [rule(statement, 'L1', WEB, 5)])], { commit: 'def5678' }), {}, 'pr-9001');
      await env.DB.prepare(
        "INSERT INTO branch_links (branch, pr_number, title, state, merged_at, issue_number, engineer, pr_updated_at, linked_at) VALUES ('b/9001', 9001, ?1, 'OPEN', NULL, NULL, NULL, '2026-10-24T08:00:00Z', 0)",
      )
        .bind(title)
        .run();

      const html = await thePage('?pr=9001&tests=Offline%7E%7E');

      expect(html).not.toMatch(/<script>alert/);
      expect(html).toContain(written);
    });
  });

  describe('the sentence says whose tests, for which rows, and offers only what it can', () => {
    it("the bare address reads main's tests for each concept area counted by level, with Area, Level, Package and Show under Only", async () => {
      await sendTestsModel(SNAPSHOT);

      const { text, choices } = theSentence(await thePage());

      expect(text).toBe('Show main’s tests for [each concept area] counted by [level]');
      expect(choices.group!.offered).toEqual(['each concept area', 'each testing level', 'each package', 'each gap']);
      expect(choices.split!.offered).toEqual(['level', 'package']);
      expect(Object.keys(choices)).toEqual(['group', 'split', 'node', 'level', 'package', 'show']);
      expect(Object.values(choices).filter((c) => c.held)).toEqual([]);
    });

    it.each([
      { situation: 'each testing level, which counts by package and offers no Level filter', query: '?group=level&level=L1', keys: ['group', 'node', 'package'] },
      { situation: 'each package, which offers no Package filter', query: '?group=package&package=api', keys: ['group', 'node', 'level'] },
      { situation: 'each gap, which offers no Level filter and carries a level held in the form', query: '?group=gaps&level=L1', keys: ['group', 'node', 'package'] },
      { situation: 'a rule opened, which counts by nothing', query: `?rule=${encodeURIComponent(`${API_INT}:20`)}`, keys: ['group', 'node', 'level', 'package', 'show'] },
    ])('$situation', async ({ query, keys }) => {
      await sendTestsModel(SNAPSHOT);

      const html = await thePage(query);

      expect(Object.keys(theSentence(html).choices)).toEqual(keys);
      if (query.startsWith('?group=gaps')) expect(html).toContain('<input type="hidden" name="level" value="L1">');
      if (!query.startsWith('?group=') || query.startsWith('?group=gaps')) expect(theSentence(html).text).not.toContain('counted by');
    });

    it('a pull request picked in the first word is read in the sentence and in the stamp', async () => {
      await sendTestsModel(SNAPSHOT);
      await sendTestsModel(model([area('Only on 9001', rules(1, 'L1', API_UNIT))], { commit: 'def5678', commitUrl: 'https://github.com/o/r/commit/def5678' }), {}, 'pr-9001');

      const html = await thePage('?pr=9001');

      expect(theSentence(html).text).toBe('Show [#9001] tests for [each concept area] counted by [level]');
      expect(plain(html)).toContain('#9001 s tests at def5678');
    });

    it.each(['', '?group=level', '?group=package', '?group=gaps'])('has no grouping tabs, no Count by toggle and no labelled filter row at %s', async (query) => {
      await sendTestsModel(SNAPSHOT);

      const html = await thePage(query);

      for (const gone of ['band-tabs', 'aria-label="Group by"', 'class="filters"', 'class="toggles"', 'aria-pressed', '<label ']) expect(html).not.toContain(gone);
    });
  });

  describe("with no snapshot of main's tests stored, the page says there is none yet", () => {
    it.each([[''], ['?group=gaps'], ['?rule=a.test.ts%3A3']])('the address %j opens the frame and says nothing has arrived', async (query) => {
      const html = await thePage(query);

      expect(plain(sectionOf(html, 'nothing'))).toContain('No snapshot of main s tests has arrived yet.');
      expect(html).toContain('<a href="/tests" aria-current="page">Tests</a>');
      expect(theSentence(html).text).toMatch(/^Show main’s tests for \[each [a-z ]+\]$/);
      expect(html).not.toContain('class="only"');
    });
  });

  describe('the sentence of a page with nothing to show keeps the rows asked for', () => {
    it('each gap asked for stays chosen, so choosing again is a change', async () => {
      expect(theSentence(await thePage('?group=gaps')).choices.group!.chosen).toBe('each gap');
    });
  });

  describe('a level has its own colour wherever the page counts by level, and a package has none', () => {
    it('the Concept area tab keys L1 to F3 in the first six slots and Contract in grey, and an area’s bar uses the same ones', async () => {
      await sendTestsModel(SNAPSHOT);

      const html = await thePage();
      const inbox = rowOf(html, 'areas', 'Inbox');

      expect(swatches(sectionOf(html, 'areas')).slice(0, 7)).toEqual([
        ['L1', slot(1)],
        ['L2', slot(2)],
        ['L3', slot(3)],
        ['F1', slot(4)],
        ['F2', slot(5)],
        ['F3', slot(6)],
        ['Contract', GREY],
      ]);
      // Inbox holds L1, L2 and F3 rules of its own: its bar has a segment for each, in their colours.
      expect(segments(cellsOf(inbox).join('')).map(([title, colour]) => [title.replace(/ \d+$/, ''), colour])).toEqual([
        ['L1', slot(1)],
        ['L2', slot(2)],
        ['F3', slot(6)],
      ]);
    });

    it('counted by package, every bar is violet', async () => {
      await sendTestsModel(SNAPSHOT);

      const bars = segments(sectionOf(await thePage('?split=package'), 'areas'));

      expect(bars.length).toBeGreaterThan(0);
      expect(new Set(coloursOf(bars))).toEqual(new Set([slot(1)]));
    });
  });

});
