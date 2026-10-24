import type { Area, Case, Model, Rule } from '../../src/tests-report';

/**
 * Snapshots of `main`'s tests as the test explorer builds them (the model of
 * tools/test-explorer/src/model.js without source lines), small enough to count
 * by hand: an area holds the rules written for it, and the page counts them.
 */

const LEVELS = ['L1', 'L2', 'L3', 'F1', 'F2', 'F3', 'Contract'];

export const kase = (text: string, file: string, line: number): Case => ({ text, file, line });

export const rule = (statement: string, level: string, file: string, line: number, cases: Case[] = [], todoCases: Case[] = [], concept = ''): Rule => ({
  concept,
  statement,
  level,
  file,
  line,
  cases,
  todoCases,
});

/** `n` rules at `level`, written in `file`, each a line apart. */
export const rules = (n: number, level: string, file: string, concept = ''): Rule[] =>
  Array.from({ length: n }, (_, i) => rule(`${level} rule ${i + 1} of ${file}`, level, file, 10 + i * 20, [kase(`${level} case`, file, 12 + i * 20)], [], concept));

/**
 * An area holding `own` rules, with `children` inside it. Its counts say
 * what it holds per level, and n/a (null) for a level it names no rule at only
 * where `notApplicable` lists it, as the explorer does for Contract.
 */
export function area(key: string, own: Rule[] = [], children: Area[] = [], over: Partial<Area> & { notApplicable?: string[] } = {}): Area {
  const { notApplicable = ['Contract'], ...rest } = over;
  return {
    key,
    label: key,
    counts: Object.fromEntries(LEVELS.map((l) => [l, notApplicable.includes(l) ? null : own.filter((r) => r.level === l).length])),
    rules: own.map((r) => ({ ...r, concept: key })),
    filesNothingRuns: [],
    branchesNothingTakes: null,
    children,
    ...rest,
  };
}

export function model(tree: Area[], over: Partial<Model> = {}): Model {
  return {
    commit: 'abc1234',
    commitUrl: 'https://github.com/o/r/commit/abc1234',
    generatedAt: '2026-10-24T03:00:00.000Z',
    tree,
    coverageAvailable: false,
    availableLevels: { L3: false },
    warnings: [],
    ...over,
  };
}

/** Every area under `tree`, parents first. */
export function* areasOf(tree: Area[]): Generator<Area> {
  for (const a of tree) {
    yield a;
    yield* areasOf(a.children);
  }
}
