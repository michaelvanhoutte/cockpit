import { createExecutionContext, env, SELF, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../../src/worker';
import { area, kase, model, rule, rules, statements } from '../fixtures/tests-model';
import { withoutExplanations } from './cockpit-support';
import { emptyTheDatabase, merged, sendTestsModel, theSentence } from './support';
import { GREY, slot, swatches } from './series-colours';

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

/** Inbox: 2 L1, 1 L2, 1 F3 of its own; Capture inside it: 2 F3. No coverage run. */
const TREE = [
  area(
    'Workspaces',
    [],
    [
      area('Inbox', [...rules(2, 'L1', API_UNIT), FOUR_CASES, ...rules(1, 'F3', E2E)], [area('Capture', rules(2, 'F3', E2E))]),
      area('Panels'),
    ],
  ),
  area('Offline', rules(1, 'L1', WEB)),
];
const SNAPSHOT = model(TREE);

/**
 * A coverage run on main: Menu.tsx is 20% run and owned by Panels and Layouts,
 * Grid.tsx 76% with more statements not run, offline.ts 85%, sync.ts in apps/api 30%.
 */
const COVERED = model(
  [
    area('Workspaces', [], [
      area('Panels', [], [], { statements: [statements('apps/web/src/Menu.tsx', 25, 5)], branchesNothingTakes: [{ file: 'apps/web/src/Menu.tsx', line: 3 }, { file: 'apps/web/src/Menu.tsx', line: 9 }] }),
      area('Layouts', [], [], { statements: [statements('apps/web/src/Menu.tsx', 25, 5), statements('apps/web/src/Grid.tsx', 100, 76)], branchesNothingTakes: [] }),
    ], { statements: [], branchesNothingTakes: [] }),
    area('Offline', rules(1, 'L1', WEB), [], { statements: [statements('apps/web/src/offline.ts', 100, 85), statements('apps/api/src/sync.ts', 100, 30)], branchesNothingTakes: [] }),
  ],
  { coverageAvailable: true },
);

const thePage = async (query = '', init: RequestInit = {}) => {
  const response = await SELF.fetch(`https://monitor.test/tests${query}`, init);
  expect(response.status).toBe(200);
  return response.text();
};

/** What the page or a panel reads as its figures, without the (i)s and the explanations they open. */
const plain = (html: string) => withoutExplanations(html).replace(/<style>.*?<\/style>/s, '').replace(/<[^>]+>/g, ' ').replace(/&[#\w]+;/g, ' ').replace(/\s+/g, ' ').trim();
const sectionOf = (html: string, id: string) => new RegExp(`<section[^>]*aria-labelledby="${id}".*?</section>`, 's').exec(html)?.[0] ?? '';
const hasSection = (html: string, id: string) => sectionOf(html, id) !== '';
/** A table row of a section, as markup, by the text its first cell starts with. */
const rowOf = (html: string, id: string, name: string) => [...sectionOf(html, id).matchAll(/<tr[ >].*?<\/tr>/gs)].map((m) => m[0]).find((row) => plain(row).startsWith(name)) ?? '';
const cellsOf = (row: string) => [...row.matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((m) => m[1]!);
/** The cell a level's count sits in on the Concept area tab: after the area's name, one per level in testing-strategy's order. */
const levelCell = (row: string, level: string) => cellsOf(row)[1 + ['L1', 'L2', 'L3', 'F1', 'F2', 'F3', 'Contract'].indexOf(level)]!;
/** An area's Covered cell, the last but one. */
const coveredCell = (row: string) => cellsOf(row).at(-2)!;
/** The tiles as text, each label followed by its figure and note. */
const tilesOf = (html: string) => plain(/<div class="tiles">\n.*?\n<\/div>/s.exec(html)?.[0] ?? '');
const hrefOf = (markup: string) => /href="([^"]*)"/.exec(markup)?.[1]?.replace(/&#38;/g, '&');

describe('Harness Monitor', () => {
  describe('the page is Test coverage with two tabs, and an old tab’s address opens Concept area', () => {
    it('opens as a page from its own tab in the top bar, Test coverage, between Test selection and CI stability', async () => {
      await sendTestsModel(SNAPSHOT);

      const html = await thePage();

      expect(html).toMatch(/<a href="\/tests" title="[^"]*" aria-current="page">Test coverage<\/a>/);
      expect(plain(html.match(/<nav class="pages".*?<\/nav>/s)![0])).toBe('Claude Code costs Cockpit s Claude calls Cycle time Test selection Test coverage CI stability');
      expect(html.match(/<h1\b/g) ?? []).toHaveLength(0);
      expect(html).toContain('abc1234');
    });

    it.each([['?group=level'], ['?group=package']])('%s opens Concept area', async (query) => {
      await sendTestsModel(SNAPSHOT);

      const html = await thePage(query);

      expect(theSentence(html).choices.group!.chosen).toBe('each concept area');
      expect(hasSection(html, 'areas')).toBe(true);
      expect(hasSection(html, 'by-level') || hasSection(html, 'by-package')).toBe(false);
    });

    it('the sentence offers each concept area and each gap only', async () => {
      await sendTestsModel(SNAPSHOT);

      expect(theSentence(await thePage()).choices.group!.offered).toEqual(['each concept area', 'each gap']);
    });
  });

  describe("main's tests are a page, and the same address answers JSON to a request that asks", () => {

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

  describe('Gaps lists the files under 80% covered, most statements not run first, each with its share, branches untaken and the areas owning it', () => {
    /** The files Gaps lists, in its order, each as its row reads. */
    const listed = (html: string) => [...sectionOf(html, 'gap-files').matchAll(/<tr><td.*?<\/tr>/gs)].map((m) => plain(m[0]));

    it('three files at 20%, 76% and 85% list the first two, the one with more statements not run first, and a file two areas own once, naming both', async () => {
      await sendTestsModel(COVERED);

      const html = await thePage('?group=gaps&package=web');

      expect(listed(html)).toEqual(['apps/web/src/Grid.tsx 24 of 100 76% 0 Layouts', 'apps/web/src/Menu.tsx 20 of 25 20% 2 Panels , Layouts']);
      expect(plain(sectionOf(html, 'gap-files'))).toContain('2 files under 80% covered, most statements no test runs first · 1 file at or above it not listed');
    });

    it('Package apps/api lists only the files of apps/api', async () => {
      await sendTestsModel(COVERED);

      expect(listed(await thePage('?group=gaps&package=api'))).toEqual(['apps/api/src/sync.ts 70 of 100 30% 0 Offline']);
    });

    it('a snapshot without coverage says the files are unknown, not none', async () => {
      await sendTestsModel(SNAPSHOT);

      const files = plain(sectionOf(await thePage('?group=gaps'), 'gap-files'));

      expect(files).toContain('Unknown, not none');
      expect(files).not.toContain('None:');
    });

    it('the prompt to copy names the files listed', async () => {
      await sendTestsModel(COVERED);

      const prompt = /<textarea id="gap-prompt" hidden>(.*?)<\/textarea>/s.exec(sectionOf(await thePage('?group=gaps'), 'gap-files'))![1]!;

      expect(prompt.split('\n').filter((l) => l.startsWith('- '))).toEqual(['- apps/api/src/sync.ts', '- apps/web/src/Grid.tsx', '- apps/web/src/Menu.tsx']);
    });
  });

  describe('Gaps lists the branches nothing takes per file with their lines, and says unknown without coverage', () => {
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
  });

  describe('Covered, its tile and the branch counts read unknown, never 0%, where the snapshot had no coverage', () => {
    it.each([
      { situation: "main's snapshot without coverage", send: () => sendTestsModel(SNAPSHOT), query: '' },
      { situation: "a pull request's snapshot", send: () => sendTestsModel(model(TREE, { commit: 'def5678' }), {}, 'pr-9001'), query: '?pr=9001' },
      { situation: 'a tree from an older analyzer, with no figures', send: () => sendTestsModel(model(TREE, { coverageAvailable: true })), query: '' },
    ])('$situation reads unknown in the column and the tile', async ({ send, query }) => {
      await send();

      const html = await thePage(query);

      expect(plain(coveredCell(rowOf(html, 'areas', 'Offline')))).toBe('unknown');
      expect(plain(coveredCell(rowOf(html, 'areas', 'Workspaces')))).toBe('unknown');
      expect(tilesOf(html)).toContain('Covered unknown');
      expect(tilesOf(html)).not.toContain('0%');
    });

    it('a snapshot with coverage draws each share, its subtree in brackets, red under 80%, and the tile its statements', async () => {
      await sendTestsModel(COVERED);

      const html = await thePage();

      expect(plain(coveredCell(rowOf(html, 'areas', 'Workspaces')))).toBe('— (64%)');
      expect(coveredCell(rowOf(html, 'areas', 'Panels'))).toContain('<span class="bad">20%</span>');
      expect(coveredCell(rowOf(html, 'areas', 'Offline'))).toContain('57%');
      expect(tilesOf(html)).toContain('Covered 60% 196 of 325 statements run · 0 files nothing runs');
    });
  });

  describe('Concept area draws no files nothing runs anywhere, and its tiles are on Concept area only', () => {
    it.each([
      { tab: 'group=area', tiles: 5 },
      { tab: 'group=gaps', tiles: 0 },
    ])('$tab draws $tiles tiles', async ({ tab, tiles }) => {
      await sendTestsModel(SNAPSHOT);

      expect((await thePage(`?${tab}`)).match(/<div class="tile /g) ?? []).toHaveLength(tiles);
    });

    it('Concept area has neither Where the rules are nor Most files nothing runs, and no files column, tile or rules bar', async () => {
      await sendTestsModel(COVERED);

      const html = await thePage();
      const head = plain(sectionOf(html, 'areas').match(/<thead>.*?<\/thead>/s)![0]);

      expect(hasSection(html, 'where')).toBe(false);
      expect(hasSection(html, 'worst')).toBe(false);
      expect(head).toBe('Area L1 L2 L3 F1 F2 F3 Contract Rules Covered Branches untaken');
      expect([...html.matchAll(/<span class="tile-label">(.*?)<span class="tile-value">/gs)].map((m) => plain(m[1]!))).toEqual(['Rules', 'Cases', 'Covered', 'Branches nothing takes', 'Areas with no rule']);
      expect(html).not.toContain('class="split"');
    });

    it('the tiles count the rules, cases and share covered of the area drilled into', async () => {
      await sendTestsModel(SNAPSHOT);

      const tiles = tilesOf(await thePage('?node=Inbox'));

      expect(tiles).toContain('Rules 6 in Inbox and the 1 area inside it');
      expect(tiles).toContain('Cases 9 in 3 test files · 1 not written yet');
      expect(tiles).toContain('Covered unknown');
    });
  });

  describe('Show keeps the areas asked for, with what holds them faint', () => {
    it('areas under 80% covered keeps Panels, Layouts and Offline, and draws Workspaces, which holds them, faint', async () => {
      await sendTestsModel(COVERED);

      const table = sectionOf(await thePage('?show=files'), 'areas');

      const rows = [...table.matchAll(/<tr class="(context)?"><td class="first">.*?<a href="[^"]*">(.*?)<\/a>/gs)].map((m) => [m[2], m[1] ?? 'kept']);
      expect(rows).toEqual([['Workspaces', 'context'], ['Panels', 'kept'], ['Layouts', 'kept'], ['Offline', 'kept']]);
    });

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

      const html = await thePage('?group=gaps&split=package');

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
      expect(choices.group!.offered).toEqual(['each concept area', 'each gap']);
      expect(choices.split!.offered).toEqual(['level', 'package']);
      expect(Object.keys(choices)).toEqual(['group', 'split', 'node', 'level', 'package', 'show']);
      expect(Object.values(choices).filter((c) => c.held)).toEqual([]);
    });

    it.each([
      { situation: 'each gap, which offers no Level filter and carries a level held in the form', query: '?group=gaps&level=L1', keys: ['group', 'node', 'package'] },
      { situation: 'a rule opened, which counts by nothing', query: `?rule=${encodeURIComponent(`${API_INT}:20`)}`, keys: ['group', 'node', 'level', 'package', 'show'] },
    ])('$situation', async ({ query, keys }) => {
      await sendTestsModel(SNAPSHOT);

      const html = await thePage(query);

      expect(Object.keys(theSentence(html).choices)).toEqual(keys);
      if (query.startsWith('?group=gaps')) expect(html).toContain('<input type="hidden" name="level" value="L1">');
      expect(theSentence(html).text).not.toContain('counted by');
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
      expect(html).toMatch(/<a href="\/tests" title="[^"]*" aria-current="page">Test coverage<\/a>/);
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
    it('the Concept area tab keys L1 to F3 in the first six slots and Contract in grey', async () => {
      await sendTestsModel(SNAPSHOT);

      const html = await thePage();

      expect(swatches(sectionOf(html, 'areas')).slice(0, 7)).toEqual([
        ['L1', slot(1)],
        ['L2', slot(2)],
        ['L3', slot(3)],
        ['F1', slot(4)],
        ['F2', slot(5)],
        ['F3', slot(6)],
        ['Contract', GREY],
      ]);
    });

    it('counted by package, no column has a colour', async () => {
      await sendTestsModel(SNAPSHOT);

      expect(swatches(sectionOf(await thePage('?split=package'), 'areas'))).toEqual([]);
    });
  });

});
