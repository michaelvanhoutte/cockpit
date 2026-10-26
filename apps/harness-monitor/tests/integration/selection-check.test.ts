import { SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { docsOnly, emptyTheDatabase, fullPackage, selectionFile, selectionJob, selectionPackage, selectionPull, sendSelection } from './support';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-15T12:00:00Z') });
  return emptyTheDatabase();
});
afterEach(() => vi.useRealTimers());

const THE_LINE = 'https://monitor.test/selection/check';

/** What opening a line asks: one pull request and one job. */
const opened = (query: string) => SELF.fetch(`${THE_LINE}${query}`);
const theLine = async (pr: number, job: 'test' | 'e2e') => {
  const response = await opened(`?pr=${pr}&job=${job}`);
  expect(response.status).toBe(200);
  return response.text();
};

/** The fragment as a reader sees it: tags dropped, entities read, spaces collapsed. */
const words = (html: string) =>
  html
    .replace(/<[/]?(?:p|li|ul|div|details|summary)(?=[ >])[^>]*>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();

const times = <T>(count: number, make: (index: number) => T) => Array.from({ length: count }, (_, index) => make(index));
const FOOTER = 'What its last CI run selected · Open its whole selection';
const link = (html: string) => /<a href="([^"]*)">Open its whole selection<\/a>/.exec(html)?.[1];

/** E2E ran every spec of its one package because `rule` named `path`. */
const everySpec = (rule: string, path: string | null) => selectionJob('e2e', { ranEverything: true, selecting: false, filesRun: 32, filesTotal: 32, packages: [fullPackage('e2e', rule, path)] });
/** A Test job that ran every package, each for the same rule and path. */
const everyPackage = (rule: string, path: string, names: string[]) => selectionJob('test', { ranEverything: true, selecting: false, filesRun: 40, filesTotal: 40, packages: names.map((name) => fullPackage(name, rule, path)) });

describe('Harness Monitor', () => {
  describe("a pull request's E2E (F3) or Test line says what that check selected on its last CI run, and links to the whole selection", () => {
    it.each([
      {
        situation: 'E2E forced by e2e support, registry or config, with the registry as the path',
        job: 'e2e' as const,
        jobs: [selectionJob('test'), everySpec('e2e support, registry or config', 'tools/test-explorer/concepts.json')],
        says: 'Ran everything: 32 of 32 specs, because e2e support, registry or config: tools/test-explorer/concepts.json Support code, the area registry or the Playwright config is shared by every walk, so it forces every spec, and should.',
        notSaying: ['every package', 'And ran some packages whole'],
      },
      {
        situation: 'Test forced in every package by one path outside every package says it once, as every package',
        job: 'test' as const,
        jobs: [everyPackage('outside every package', 'readme.md', ['api', 'web', 'worker']), selectionJob('e2e')],
        says: 'Ran everything: 40 of 40 test files, because outside every package: readme.md · every package A file outside every package’s directory forces every package',
        notSaying: ['And ran some packages whole', 'api'],
      },
      {
        situation: 'Test forced in two of three packages by different rules names the packages of each',
        job: 'test' as const,
        jobs: [
          selectionJob('test', {
            ranEverything: true,
            selecting: false,
            filesRun: 40,
            filesTotal: 40,
            packages: [fullPackage('api', 'own migration', 'apps/api/migrations/0042.sql'), fullPackage('web', 'own vitest config', 'apps/web/vitest.config.ts'), fullPackage('worker', 'own migration', 'apps/api/migrations/0042.sql')],
          }),
          selectionJob('e2e'),
        ],
        says: 'Ran everything: 40 of 40 test files, because own migration: apps/api/migrations/0042.sql · api, worker',
        notSaying: ['every package'],
      },
      {
        situation: 'a rule with no advice written says so',
        job: 'e2e' as const,
        jobs: [selectionJob('test'), everySpec('a rule nobody has written about', 'apps/api/src/b.ts')],
        says: 'because a rule nobody has written about: apps/api/src/b.ts No advice is written for this rule yet.',
        notSaying: [],
      },
    ])('$situation', async ({ job, jobs, says, notSaying }) => {
      await sendSelection([selectionPull(1, { jobs })]);

      const html = await theLine(1, job);

      const read = words(html);
      expect(read).toContain(says);
      for (const word of notSaying) expect(read).not.toContain(word);
      expect(read.endsWith(FOOTER)).toBe(true);
      expect(link(html)).toBe(`/selection?group=pr&#38;job=${job}&#38;pr=1`);
    });

    it('a Test job that selected, with one package forced whole by its own migration, says both, naming the package that ran whole', async () => {
      const api = selectionPackage('api', [selectionFile('apps/api/tests/unit/a.test.ts')], { filesTotal: 30 });
      await sendSelection([selectionPull(1, { jobs: [selectionJob('test', { filesRun: 11, filesTotal: 40, packages: [api, fullPackage('worker', 'own migration', 'apps/worker/migrations/1.sql')] }), selectionJob('e2e')] })]);

      const read = words(await theLine(1, 'test'));

      expect(read).toContain('Selected a subset: 11 of 40 test files');
      expect(read).toContain('And ran some packages whole, because own migration: apps/worker/migrations/1.sql · worker');
      expect(read).not.toContain('Ran everything');
    });
  });

  describe('a check that did not run, left no record, or is not held says which', () => {
    it.each([
      { situation: 'E2E documentation only', jobs: [selectionJob('test'), docsOnly('e2e')], pr: 1, says: 'Did not run: the change was documentation only.', footer: true },
      { situation: 'E2E with no record of what it selected', jobs: [selectionJob('test'), selectionJob('e2e', { status: 'no-record', selecting: false, filesRun: null, filesTotal: null, packages: [] })], pr: 1, says: 'No record of what it selected.', footer: true },
      { situation: 'a pull request the selection rows do not hold', jobs: [selectionJob('test'), selectionJob('e2e')], pr: 2, says: 'The Monitor holds no test selection record for this pull request.', footer: false },
    ])('$situation', async ({ jobs, pr, says, footer }) => {
      await sendSelection([selectionPull(1, { jobs })]);

      const read = words(await theLine(pr, 'e2e'));

      expect(read.startsWith(says)).toBe(true);
      expect(read.endsWith(FOOTER)).toBe(footer);
    });
  });

  describe('a check that selected is grouped by the changed file its chain started from, with every file it selected', () => {
    it('a pull request that selected 466 test files returns each of them, under the changed file that picked it, the largest group first', async () => {
      const through = (path: string, start: string) => selectionFile(path, { selectedBy: { kind: 'chain', chain: [path, 'apps/api/src/index.ts', start], text: `${path} → apps/api/src/index.ts → ${start}` } });
      const own = (path: string) => selectionFile(path, { selectedBy: { kind: 'itself', text: path } });
      const files = [
        ...times(300, (n) => through(`apps/api/tests/unit/item-${n}.test.ts`, 'apps/api/src/item.ts')),
        ...times(160, (n) => through(`apps/api/tests/unit/client-${n}.test.ts`, 'apps/api/src/client.ts')),
        ...times(6, (n) => own(`apps/api/tests/unit/own-${n}.test.ts`)),
      ];
      await sendSelection([selectionPull(1, { jobs: [selectionJob('test', { filesRun: 466, filesTotal: 468, packages: [selectionPackage('api', files, { filesTotal: 468 })] }), selectionJob('e2e')] })]);

      const html = await theLine(1, 'test');

      const read = words(html);
      expect(read).toContain('Selected a subset: 466 of 468 test files · api 466 of 468');
      expect(read).toContain('Reached from 3 starting points');
      expect([...html.matchAll(/<summary>.*?<\/summary>/gs)].map((m) => words(m[0]))).toEqual([
        'apps/api/src/item.ts → 300 test files · api 300 mostly through apps/api/src/index.ts (300 of 300)',
        'apps/api/src/client.ts → 160 test files · api 160 mostly through apps/api/src/index.ts (160 of 160)',
        'The test files that changed themselves → 6 test files · api 6',
      ]);
      expect(html.match(/<li><span class="mono">apps\/api\/tests\/unit\//g)).toHaveLength(466);
    });

    it('an E2E spec picked by its area is grouped under the area’s own words, with no package counts', async () => {
      const spec = (path: string, text: string) => selectionFile(path, { level: 'F3', selectedBy: { kind: 'concept', owners: [{ concept: 'Panels', path: 'apps/web/src/DashboardBar.tsx' }], text } });
      const text = 'owned by Panels, through `apps/web/src/DashboardBar.tsx`, changed';
      await sendSelection([selectionPull(1, { jobs: [selectionJob('test'), selectionJob('e2e', { filesRun: 2, filesTotal: 32, packages: [selectionPackage('e2e', [spec('tests/e2e/filing.test.ts', text), spec('tests/e2e/panels.test.ts', text)], { filesTotal: 32 })] })] })]);

      const read = words(await theLine(1, 'e2e'));

      expect(read).toContain('Selected a subset: 2 of 32 specs');
      expect(read).toContain('owned by Panels, through apps/web/src/DashboardBar.tsx, changed → 2 specs');
      expect(read).not.toContain('e2e 2');
    });
  });

  describe('the line reads one pull request and one job, and refuses anything else', () => {
    it.each([
      { situation: 'a pull request that is not a number', query: '?pr=latest&job=test' },
      { situation: 'a pull request of zero', query: '?pr=0&job=test' },
      { situation: 'a negative pull request', query: '?pr=-3&job=e2e' },
      { situation: 'a pull request with a fraction', query: '?pr=1.5&job=e2e' },
      { situation: 'no pull request', query: '?job=test' },
      { situation: 'no job', query: '?pr=1' },
      { situation: 'a job that is neither Test nor E2E', query: '?pr=1&job=checks' },
      { situation: 'both jobs at once', query: '?pr=1&job=both' },
    ])('$situation is refused, 400', async ({ query }) => {
      await sendSelection([selectionPull(1)]);

      const response = await opened(query);

      expect(response.status).toBe(400);
    });
  });
});
