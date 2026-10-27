import { describe, expect, it } from 'vitest';
import { analysisPrompt, askData, gapsPrompt, pickOf } from '../../src/tests-prompts';
import { indexOf, type Area, type Model, type TestsQuery } from '../../src/tests-report';
import { area, model, rules, statements } from '../fixtures/tests-model';

const API = 'apps/api/tests/unit/a.test.ts';
const E2E = 'tests/e2e/dashboards.test.ts';

/** The lines of `prompt` that name a file, each as written. */
const fileLines = (prompt: string) => prompt.split('\n').filter((l) => /^ *- \S+\.tsx? \(/.test(l));

describe('Harness Monitor', () => {
  describe('the prompt for the picked files names each one with its share, its area and the lines no test runs, then asks for one of three outcomes per file in one pull request', () => {
    const panels = area('Panels');
    const layouts = area('Layouts');
    const menu = statements('apps/web/src/Menu.tsx', 25, 5, ['3-9', '14']);
    const grid = statements('apps/web/src/Grid.tsx', 100, 76, ['40-58']);
    const wiring = statements('apps/api/src/wiring.ts', 10, 2, ['1-8']);

    it.each([
      {
        situation: 'two files picked: both, in the list’s order, each with its share, area and lines',
        picked: [pickOf(grid, [layouts]), pickOf(menu, [panels])],
        named: ['- apps/web/src/Grid.tsx (76% of statements run; area: Layouts): lines 40-58', '- apps/web/src/Menu.tsx (20% of statements run; area: Panels): lines 3-9, 14'],
      },
      { situation: 'a file owned by two areas: names both', picked: [pickOf(menu, [panels, layouts])], named: ['- apps/web/src/Menu.tsx (20% of statements run; area: Panels, Layouts): lines 3-9, 14'] },
      { situation: 'a file with no area: names none', picked: [pickOf(wiring, [])], named: ['- apps/api/src/wiring.ts (20% of statements run): lines 1-8'] },
    ])('$situation', ({ picked, named }) => {
      expect(fileLines(gapsPrompt(picked))).toEqual(named);
    });

    it('the closing asks for one of the three outcomes per file, names the list, and asks for one pull request', () => {
      const closing = gapsPrompt([pickOf(menu, [panels])]).split('\n').slice(4);

      expect(closing).toEqual([
        'For each file, read the lines listed and decide which applies:',
        '- they carry behaviour someone relies on: add the test that proves it, at the lowest level that can, following the testing skill;',
        '- they are dead code: delete them;',
        '- no test is worth writing (wiring, a type, a log line): leave them, and add the file with your reason to tools/test-explorer/not-worth-a-test.json, which moves it to the page\'s "Decided not to test" list.',
        '',
        'Open one pull request for all of them, and say in its body which of the three you did for each file.',
      ]);
    });
  });

  describe('the analysis prompt covers an area and everything inside it with the figures the page shows', () => {
    /** Dashboards holds Panels, Layouts and Focus: 2 L1 and 1 F3 rule, Menu.tsx 20% and Grid.tsx 76% run, two branches no test takes. */
    const DASHBOARDS = area(
      'Dashboards',
      [],
      [
        area('Panels', rules(2, 'L1', API), [], { statements: [statements('apps/web/src/Menu.tsx', 25, 5, ['3-9'])], branchesNothingTakes: [{ file: 'apps/web/src/Menu.tsx', line: 3 }, { file: 'apps/web/src/Menu.tsx', line: 9 }] }),
        area('Layouts', rules(1, 'F3', E2E), [], { statements: [statements('apps/web/src/Grid.tsx', 100, 76, ['40-58']), statements('apps/web/src/Layout.tsx', 10, 10)], branchesNothingTakes: [] }),
        area('Focus', [], [], { statements: [], branchesNothingTakes: [] }),
      ],
      { statements: [], branchesNothingTakes: [] },
    );
    const promptFor = (tree: Area[], key: string, q: Pick<TestsQuery, 'level' | 'package'> = { level: null, package: null }, notWorthATest: Model['notWorthATest'] = []) => {
      const m = model([area('Workspaces', [], tree, { statements: [], branchesNothingTakes: [] })], { coverageAvailable: true, notWorthATest });
      const ix = indexOf(m);
      return analysisPrompt(askData(m, ix, [ix.byKey.get(key)!], q), key);
    };

    it('Dashboards, holding Panels, Layouts and Focus, names the three, its share, the branches no test takes and its rules per level', () => {
      const lines = promptFor([DASHBOARDS], 'Dashboards').split('\n');

      expect(lines[0]).toBe('Analyse the test coverage of the "Dashboards" area of Cockpit (Workspaces › Dashboards) and the 3 areas inside it (Panels, Layouts, Focus), and suggest the tests worth adding. Suggest only: write no code and no tests.');
      expect(lines[2]).toBe("What the Harness Monitor's Test coverage page shows for it, from CI's coverage run on main at abc1234:");
      expect(lines[3]).toBe('- 67% of 135 statements run; 2 branches no test takes.');
      expect(lines[4]).toBe('- Rules per testing level: L1 2, L2 0, L3 n/a, F1 0, F2 0, F3 1, Contract n/a.');
      expect(fileLines(lines.join('\n'))).toEqual([
        '  - apps/web/src/Grid.tsx (76% run, 24 of 100 statements not run): lines 40-58',
        '  - apps/web/src/Menu.tsx (20% run, 20 of 25 statements not run): lines 3-9',
      ]);
    });

    it.each([
      { situation: 'a file decided not worth a test with no more of it unrun since is left out', notRun: 20, files: ['apps/web/src/Grid.tsx'] },
      { situation: 'a file decided not worth a test with more of it unrun since is named', notRun: 5, files: ['apps/web/src/Grid.tsx', 'apps/web/src/Menu.tsx'] },
    ])('$situation', ({ notRun, files }) => {
      const prompt = promptFor([DASHBOARDS], 'Dashboards', undefined, [{ file: 'apps/web/src/Menu.tsx', reason: 'Wiring only', notRun }]);

      expect(prompt).toContain('- 67% of 135 statements run; 2 branches no test takes.');
      expect(fileLines(prompt).map((l) => l.trim().split(' ')[1])).toEqual(files);
    });

    it('a level that is n/a says n/a, never 0, and the Level filter names only its own', () => {
      const prompt = promptFor([DASHBOARDS], 'Dashboards', { level: 'L3', package: null });

      expect(prompt).toContain('from CI\'s coverage run on main at abc1234, L3 only:');
      expect(prompt).toContain('- Rules per testing level: L3 n/a.');
    });

    it('an area with 39 files with lines no test runs names the 25 with most not run, as the top 25 of 39', () => {
      const many = Array.from({ length: 39 }, (_, i) => statements(`apps/web/src/f${String(i + 1).padStart(2, '0')}.ts`, 100, 50 + i, ['1']));

      const prompt = promptFor([area('Big', [], [], { statements: many, branchesNothingTakes: [] })], 'Big');

      expect(prompt).toContain('- Files with lines no test runs, most first (the top 25 of 39):');
      expect(fileLines(prompt)).toHaveLength(25);
      expect(fileLines(prompt)[0]).toContain('apps/web/src/f01.ts (50% run, 50 of 100');
      expect(fileLines(prompt)[24]).toContain('apps/web/src/f25.ts (74% run, 26 of 100');
    });

    it('a file with over 15 ranges of lines no test runs names the first 15, then how many more', () => {
      const ranges = Array.from({ length: 18 }, (_, i) => String(i * 3 + 1));

      const prompt = promptFor([area('Gappy', [], [], { statements: [statements('apps/web/src/gappy.ts', 40, 10, ranges)], branchesNothingTakes: [] })], 'Gappy');

      expect(fileLines(prompt)).toEqual([`  - apps/web/src/gappy.ts (25% run, 30 of 40 statements not run): lines ${ranges.slice(0, 15).join(', ')}, and 3 more ranges`]);
    });
  });
});
