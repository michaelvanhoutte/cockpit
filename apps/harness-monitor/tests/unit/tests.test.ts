import { describe, expect, it } from 'vitest';
import { MAX_PART_BYTES, readArea, readTree, snapshotOf } from '../../src/tests';

const COMMIT = 'abc1234';

const gzip = async (value: unknown) =>
  new Uint8Array(await new Response(new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());

const area = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  label: key,
  counts: { L1: 1 },
  rules: [{ concept: key, statement: 'a rule', level: 'L1', file: 'a.test.ts', line: 3, cases: [{ text: 'a case', file: 'a.test.ts', line: 4 }], todoCases: [] }],
  branchesNothingTakes: null,
  children: [],
  ...over,
});

const tree = (over: Record<string, unknown> = {}) => ({ commit: COMMIT, coverageAvailable: false, tree: [area('Capture'), area('Triage')], ...over });

/** Bytes that do not compress, so their gzipped size is their size. */
const incompressible = (size: number) => {
  const bytes = new Uint8Array(size);
  let seed = 7;
  for (let i = 0; i < size; i += 1) bytes[i] = (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24;
  return bytes;
};

describe('Harness Monitor', () => {
  describe("a part of main's tests of the wrong shape, or larger than one part may hold, is refused, naming it", () => {
    it('an area over the size one part may hold is refused before it is read, naming the area and the limit', async () => {
      const checked = await readArea('Capture', incompressible(MAX_PART_BYTES + 1));

      expect(checked).toEqual({ ok: false, error: expect.stringMatching(/^Area "Capture" is 1,900,001 bytes gzipped, over the 1,900,000 a part may hold/) });
    });

    it.each([
      { situation: 'a tree with no commit', sent: tree({ commit: undefined }), error: 'The tree has no commit.' },
      { situation: 'a tree whose commit could not be read', sent: tree({ commit: 'unknown' }), error: 'The tree\'s commit "unknown" is not one.' },
      { situation: 'a tree of another commit than it was sent as', sent: tree({ commit: 'def5678' }), error: 'The tree is commit def5678, but was sent as abc1234.' },
      { situation: 'a tree not saying whether coverage was available', sent: tree({ coverageAvailable: 'yes' }), error: 'The tree does not say whether coverage was available.' },
      { situation: 'a tree naming one area twice', sent: tree({ tree: [area('Capture'), area('Triage', { children: [area('Capture')] })] }), error: 'Area "Capture" appears twice.' },
      {
        situation: 'a tree carrying its source lines',
        sent: tree({ tree: [area('Capture', { branchesNothingTakes: [{ file: 'a.ts', line: 1, context: [{ line: 1, text: 'x' }] }] })] }),
        error: 'Area "Capture" carries source lines; they belong in its own part.',
      },
      {
        situation: 'a tree with a rule whose statement is not text',
        sent: tree({ tree: [area('Capture', { rules: [{ concept: 'Capture', statement: 7, level: 'L1', file: 'a.test.ts', line: 3, cases: [] }] })] }),
        error: 'Area "Capture": the rule at "a.test.ts:3" has no statement.',
      },
      {
        situation: 'a tree with a case whose text is not text',
        sent: tree({ tree: [area('Capture', { rules: [{ concept: 'Capture', statement: 'a rule', level: 'L1', file: 'a.test.ts', line: 3, cases: [{ text: null, file: 'a.test.ts', line: 4 }] }] })] }),
        error: 'Area "Capture": the rule at "a.test.ts:3" has a case that is not {file, line, text}.',
      },
      {
        situation: 'a tree with a gap that has no file',
        sent: tree({ tree: [area('Capture', { branchesNothingTakes: [{ line: 1 }] })] }),
        error: 'Area "Capture"\'s branchesNothingTakes is not a list of {file, line}.',
      },
      {
        situation: 'a tree whose warnings are not text',
        sent: tree({ warnings: [1] }),
        error: 'The tree has warnings that are not a list of text.',
      },
      {
        situation: 'a tree whose commit link is not text',
        sent: tree({ commitUrl: ['https://github.com/o/r/commit/abc1234'] }),
        error: "The tree's commit link is not text.",
      },
    ])('$situation is refused', async ({ sent, error }) => {
      expect(await readTree(COMMIT, await gzip(sent))).toEqual({ ok: false, error });
    });

    it.each([
      { situation: 'source lines that are not a list', sent: { 'a.ts:3': 'line three' }, error: 'Area "Capture": "a.ts:3" is not a list of at most 100 lines.' },
      { situation: 'a line without its number', sent: { 'a.ts:3': [{ text: 'line three' }] }, error: 'Area "Capture": "a.ts:3" holds a line that is not {line, text}.' },
    ])('an area with $situation is refused', async ({ sent, error }) => {
      expect(await readArea('Capture', await gzip(sent))).toEqual({ ok: false, error });
    });

    it('a part that is not gzip is refused', async () => {
      expect(await readArea('Capture', new TextEncoder().encode('{"a.ts:3": []}'))).toEqual({ ok: false, error: 'Area "Capture" is not gzip.' });
    });

    it('a branch nothing takes with no line, as coverage gives an untaken implicit else, is read', async () => {
      const checked = await readTree(COMMIT, await gzip(tree({ tree: [area('Capture', { branchesNothingTakes: [{ file: 'a.ts' }, { file: 'a.ts', line: 9 }] })] })));

      expect(checked).toEqual({ ok: true, value: { commit: COMMIT, areas: ['Capture'] } });
    });

    it('a well-formed tree is read with every area it names, nested ones included', async () => {
      const checked = await readTree(COMMIT, await gzip(tree({ tree: [area('Workspaces', { children: [area('Capture')] }), area('Triage')] })));

      expect(checked).toEqual({ ok: true, value: { commit: COMMIT, areas: ['Workspaces', 'Capture', 'Triage'] } });
    });
  });

  describe("a tree's coverage figures of the wrong shape are refused, naming the area", () => {
    const file = (over: Record<string, unknown> = {}) => ({ file: 'apps/web/src/a.ts', total: 10, covered: 4, uncovered: ['3-8'], ...over });

    it.each([
      { situation: 'figures that are not a list', statements: { 'apps/web/src/a.ts': 10 }, error: 'Area "Capture"\'s statements are not a list.' },
      { situation: 'more statements run than the file has', statements: [file({ covered: 11 })], error: 'Area "Capture": "apps/web/src/a.ts" has more statements run than it has.' },
      { situation: 'unrun lines that are not text', statements: [file({ uncovered: [3, 8] })], error: 'Area "Capture": "apps/web/src/a.ts" has lines not run that are not a list of text.' },
    ])('$situation is refused', async ({ statements, error }) => {
      expect(await readTree(COMMIT, await gzip(tree({ tree: [area('Capture', { statements })] })))).toEqual({ ok: false, error });
    });

    it.each([
      { situation: 'a tree with no figures, from an older analyzer', over: {} },
      { situation: 'a tree whose run had no coverage', over: { statements: null } },
      { situation: 'a tree with figures', over: { statements: [file(), file({ file: 'apps/web/src/b.ts', covered: 10, uncovered: [] })] } },
    ])('$situation is read', async ({ over }) => {
      expect(await readTree(COMMIT, await gzip(tree({ tree: [area('Capture', over)] })))).toEqual({ ok: true, value: { commit: COMMIT, areas: ['Capture'] } });
    });
  });

  describe("tests are sent as main's or as one pull request's, and as nothing else", () => {
    it.each([
      { situation: "main's", raw: 'main', snapshot: 'main' },
      { situation: "pull request 9001's", raw: 'pr-9001', snapshot: 'pr-9001' },
      { situation: 'a pull request written with a leading zero', raw: 'pr-09001', snapshot: null },
      { situation: 'pull request 0', raw: 'pr-0', snapshot: null },
      { situation: 'a branch', raw: 'feature', snapshot: null },
    ])('$situation is read as $snapshot', ({ raw, snapshot }) => {
      expect(snapshotOf(raw)).toBe(snapshot);
    });
  });
});
