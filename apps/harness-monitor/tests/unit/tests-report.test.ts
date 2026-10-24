import { describe, expect, it } from 'vitest';
import {
  branchGaps,
  countOf,
  deepRules,
  DEFAULT_QUERY,
  distinctFiles,
  indexOf,
  keepOf,
  ownFiles,
  ownRules,
  parseTestsQuery,
  rowsUnder,
  showRows,
  testsAddress,
  testsBehind,
  type TestsQuery,
} from '../../src/tests-report';
import { area, model, rule, rules } from '../fixtures/tests-model';

const API = 'apps/api/tests/unit/a.test.ts';
const WEB = 'apps/web/tests/unit/w.test.ts';
const E2E = 'tests/e2e/capture.test.ts';

/** Inbox holds 4 L1 rules of its own; Capture inside it holds 6, in another package. */
const INBOX = area('Inbox', rules(4, 'L1', API), [area('Capture', rules(6, 'L1', WEB))]);
const query = (over: Partial<TestsQuery> = {}): TestsQuery => ({ ...DEFAULT_QUERY, ...over });

describe('Harness Monitor', () => {
  describe('an area counts its own rules per level or package, then everything inside it in brackets', () => {
    const snapshot = model([INBOX]);
    const keep = keepOf(query());

    it('Inbox with 4 L1 rules and Capture inside it with 6 counts 4, and 10 inside it', () => {
      expect(countOf(snapshot, INBOX, 'level', 'L1', ownRules(INBOX, keep), false)).toBe(4);
      expect(countOf(snapshot, INBOX, 'level', 'L1', deepRules(INBOX, keep), true)).toBe(10);
    });

    it('the same rules counted by package split where their files live', () => {
      expect(countOf(snapshot, INBOX, 'package', 'api', ownRules(INBOX, keep), false)).toBe(4);
      expect(countOf(snapshot, INBOX, 'package', 'web', ownRules(INBOX, keep), false)).toBe(0);
      expect(countOf(snapshot, INBOX, 'package', 'web', deepRules(INBOX, keep), true)).toBe(6);
    });

    it.each([
      { situation: 'a level no contract suite names', level: 'Contract', model: snapshot },
      { situation: 'a level the whole repository lacks', level: 'L3', model: model([INBOX], { availableLevels: { L3: false } }) },
    ])('$situation is n/a, never 0', ({ level, model: m }) => {
      const noRules = area('Offline', [], [], { notApplicable: [level] });
      expect(countOf(m, noRules, 'level', level, [], false)).toBeNull();
      expect(countOf(m, noRules, 'level', level, [], true)).toBeNull();
    });

    it('a row holding others is n/a inside it only where every area inside it is', () => {
      const parent = area('Workspaces', [], [area('Inbox', [rule('r', 'L1', API, 3)], [], { notApplicable: ['F3'] }), area('Panels', [], [], { notApplicable: [] })], { notApplicable: ['F3'] });

      expect(countOf(model([parent]), parent, 'level', 'F3', [], true)).toBe(0);
    });
  });

  describe('Level and Package decide which rules are counted everywhere on the page; Show keeps the areas asked for, with what holds them faint', () => {
    const f3 = rules(3, 'F3', E2E);
    const tree = [area('Workspaces', [], [area('Inbox', [...rules(2, 'L1', API), ...f3]), area('Panels', rules(1, 'L1', API))]), area('Offline', rules(1, 'F3', E2E))];
    const snapshot = model(tree);
    const ix = indexOf(snapshot);

    it('Level F3 with Show: areas with no F3 rule keeps only those, and their parent faint', () => {
      const q = query({ level: 'F3', show: 'empty' });

      const { shown, matched } = showRows(rowsUnder(snapshot, null), q, keepOf(q), ix);

      expect([...matched]).toEqual(['Panels']);
      expect(shown.map((r) => r.area.key)).toEqual(['Workspaces', 'Panels']);
    });

    it('Level F3 counts only the F3 rules of an area and of what is inside it', () => {
      const keep = keepOf(query({ level: 'F3' }));

      expect(ownRules(tree[0]!, keep)).toHaveLength(0);
      expect(deepRules(tree[0]!, keep)).toHaveLength(3);
    });

    it('Package apps/api on Gaps counts only the files of apps/api nothing runs', () => {
      const gaps = area('Offline', [], [], { filesNothingRuns: [{ file: 'apps/api/src/a.ts', line: 1 }, { file: 'apps/web/src/b.ts', line: 1 }, { file: 'apps/api/src/c.ts', line: 1 }] });

      expect(ownFiles(gaps, keepOf(query({ package: 'api' }))).map((f) => f.file)).toEqual(['apps/api/src/a.ts', 'apps/api/src/c.ts']);
    });

    it('a file owned by two areas is one gap', () => {
      const shared = [{ file: 'apps/api/src/shared.ts', line: 1 }];
      const a = area('One', [], [], { filesNothingRuns: shared });
      const b = area('Two', [], [], { filesNothingRuns: shared });

      expect(distinctFiles([a, b], keepOf(query())).size).toBe(1);
    });

    it('Show: areas with files nothing runs keeps the areas that own one', () => {
      const withGap = area('Offline', [], [], { filesNothingRuns: [{ file: 'apps/web/src/o.ts', line: 1 }] });
      const t = [area('Workspaces', [], [withGap, area('Panels')])];

      const { matched } = showRows(rowsUnder(model(t), null), query({ show: 'files' }), keepOf(query()), indexOf(model(t)));

      expect([...matched]).toEqual(['Offline']);
    });

    it('branches nothing takes are counted once per file, by the most any one area holds of it', () => {
      const both = [{ file: 'apps/api/src/x.ts', line: 3 }, { file: 'apps/api/src/x.ts', line: 9 }];
      const a = area('One', [], [], { branchesNothingTakes: both });
      const b = area('Two', [], [], { branchesNothingTakes: [both[0]!] });

      expect(branchGaps([a, b], keepOf(query()))).toBe(2);
      expect(branchGaps([a, b], keepOf(query({ package: 'web' })))).toBe(0);
    });
  });

  describe('a count opens exactly the tests behind it, area by area', () => {
    const tree = [area('Workspaces', [], [area('Inbox', [...rules(1, 'F3', E2E), ...rules(2, 'L1', API)], [area('Capture', rules(2, 'F3', E2E))]), area('Panels', rules(1, 'F3', E2E))])];
    const snapshot = model(tree);
    const ix = indexOf(snapshot);

    it("Inbox's F3 count opens the F3 rules of Inbox and of what is inside it, under the areas that own them", () => {
      const opened = testsBehind(snapshot, ix, { node: 'Inbox', level: 'F3', package: null });

      expect(opened.map((x) => [x.area.key, x.rules.length])).toEqual([['Inbox', 1], ['Capture', 2]]);
    });

    it("a package column's count on Testing level opens that level's rules in that package", () => {
      const opened = testsBehind(snapshot, ix, { node: null, level: 'F3', package: 'e2e' });

      expect(opened.reduce((n, x) => n + x.rules.length, 0)).toBe(4);
      expect(testsBehind(snapshot, ix, { node: null, level: 'F3', package: 'api' })).toEqual([]);
    });
  });

  describe('a view lives in its address, so a link reopens exactly it', () => {
    it.each([
      { situation: 'the bare address', address: '/tests', q: query() },
      { situation: 'a drilled-in area on another tab', address: '/tests?group=level&node=Inbox', q: query({ group: 'level', node: 'Inbox' }) },
      { situation: 'filters and a count by package', address: '/tests?level=F3&package=api&show=empty&split=package', q: query({ level: 'F3', package: 'api', show: 'empty', split: 'package' }) },
      { situation: 'the tests behind a count, with the page filters kept', address: '/tests?level=L1&tests=Inbox%7EF3%7E', q: query({ level: 'L1', list: { node: 'Inbox', level: 'F3', package: null } }) },
      { situation: 'a rule', address: '/tests?rule=a.test.ts%3A12', q: query({ rule: 'a.test.ts:12' }) },
      { situation: "a pull request's tests, drilled in", address: '/tests?node=Inbox&pr=9001', q: query({ node: 'Inbox', pr: 9001 }) },
    ])('$situation', ({ address, q }) => {
      expect(parseTestsQuery(new URL(`https://monitor.test${address}`).searchParams)).toEqual(q);
      expect(testsAddress(q, { rule: q.rule, list: q.list })).toBe(address);
    });

    it('a level, package or tab it does not know falls back to the default instead of failing', () => {
      const q = parseTestsQuery(new URLSearchParams('group=nope&level=L9&package=zzz&show=x&split=y&tests=a~b~c~d'));

      expect(q).toEqual(query());
    });

    it.each([['09001'], ['-1'], ['0'], ['9001x'], ['12345678901']])("a pull request written %j is not one, so main's tests are shown", (pr) => {
      expect(parseTestsQuery(new URLSearchParams({ pr })).pr).toBeNull();
    });

    it.each([['an unknown level', 'Inbox~L9~'], ['an unknown package', 'Inbox~~zzz'], ['an area name too long to be one', `${'a'.repeat(401)}~L1~`]])('a list with %s is dropped, since leaving that part empty would mean every one', (_, tests) => {
      expect(parseTestsQuery(new URLSearchParams({ tests })).list).toBeNull();
    });
  });
});
