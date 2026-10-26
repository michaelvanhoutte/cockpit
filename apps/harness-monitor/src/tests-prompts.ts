import { branchGaps, coverageOf, deepRules, filesCovered, keepOf, LEVELS, levelNotApplicable, pathOf, percent, pkgLabel, walk, type Area, type FileStatements, type Index, type Model, type TestsQuery } from './tests-report';

/**
 * The two prompts Test coverage copies, built in the browser from data the
 * page carries once, so a click sends no request (a write to the clipboard
 * after an awaited fetch is refused by Safari). `gapsPrompt` and
 * `analysisPrompt` run in the page as written here: the page carries each as
 * its source text, so each needs nothing outside itself and its argument.
 * What the page carries for them is built here on the server, from the same
 * figures the page draws.
 */

/** A file picked on Gaps, as its checkbox carries it: its path, its share run, its lines no test runs, and the areas owning it. */
export interface PickedFile {
  file: string;
  pct: string;
  lines: string;
  areas: string;
}

/** What a file's checkbox on Gaps carries. */
export const pickOf = (f: FileStatements, owners: Area[]): PickedFile => ({ file: f.file, pct: percent(f), lines: (f.uncovered ?? []).join(', '), areas: owners.map((a) => a.label).join(', ') });

/**
 * The prompt for the files picked on Gaps, in the order listed: each with its
 * share, its areas and the lines no test runs, then one of three outcomes per
 * file, in one pull request. Runs in the page.
 */
export function gapsPrompt(chosen: PickedFile[]): string {
  return [
    "Close these test coverage gaps in Cockpit. CI's coverage run on main shows the lines listed are run by no test.",
    '',
  ]
    .concat(chosen.map((p) => '- ' + p.file + ' (' + p.pct + ' of statements run' + (p.areas ? '; area: ' + p.areas : '') + '): lines ' + p.lines))
    .concat([
      '',
      'For each file, read the lines listed and decide which applies:',
      '- they carry behaviour someone relies on: add the test that proves it, at the lowest level that can, following the testing skill;',
      '- they are dead code: delete them;',
      '- no test is worth writing (wiring, a type, a log line): leave them, and add the file with your reason to tools/test-explorer/not-worth-a-test.json, which moves it to the page\'s "Decided not to test" list.',
      '',
      'Open one pull request for all of them, and say in its body which of the three you did for each file.',
    ])
    .join('\n');
}

/** A file with lines no test runs, as the analysis prompt names it. */
export interface AskFile {
  file: string;
  total: number;
  covered: number;
  uncovered: string[];
}
/** An area as its analysis prompt describes it: where it sits, what is inside it, and the figures the page shows for it and everything inside it. */
export interface AskArea {
  label: string;
  /** Its ancestors and itself, outermost first, joined by ›. */
  where: string;
  /** The labels of every area inside it, in the tree's order. */
  inside: string[];
  /** Its files with lines no test runs, as places in `AskData.files`, most statements not run first. */
  files: number[];
  total: number;
  covered: number;
  branches: number;
  /** Its rules per testing level the page counts, each `L1 3`, or `Contract n/a` where the level cannot apply. */
  levels: string[];
}
/** What the page carries once for every spark icon: each file once, and each area drawn by its key. */
export interface AskData {
  commit: string;
  /** The Level and Package filters in force, as the page says them, or ''. */
  qualifier: string;
  files: AskFile[];
  areas: Record<string, AskArea>;
}

/**
 * The analysis-only prompt the spark icon beside an area's Covered copies: the
 * area and everything inside it, with its figures and its 25 files with most
 * statements not run, each with its first 15 ranges of lines no test runs.
 * Runs in the page.
 */
export function analysisPrompt(data: AskData, key: string): string {
  const a = data.areas[key]!;
  const files = a.files.map((i) => data.files[i]!);
  const shown = files.slice(0, 25);
  const count = a.inside.length;
  return [
    `Analyse the test coverage of the "${a.label}" area of Cockpit (${a.where})${count ? ` and the ${count.toLocaleString('en-US')} ${count === 1 ? 'area' : 'areas'} inside it (${a.inside.join(', ')})` : ''}, and suggest the tests worth adding. Suggest only: write no code and no tests.`,
    '',
    `What the Harness Monitor's Test coverage page shows for it, from CI's coverage run on main at ${data.commit}${data.qualifier ? `, ${data.qualifier}` : ''}:`,
    `- ${a.total ? `${Math.floor((a.covered * 100) / a.total)}% of ${a.total} statements run` : 'no statements measured'}; ${a.branches} branches no test takes.`,
    `- Rules per testing level: ${a.levels.join(', ')}.`,
    `- Files with lines no test runs, most first${files.length > shown.length ? ` (the top ${shown.length} of ${files.length})` : ''}:`,
    ...shown.map(
      (f) =>
        `  - ${f.file} (${Math.floor((f.covered * 100) / f.total)}% run, ${f.total - f.covered} of ${f.total} statements not run): lines ${f.uncovered.slice(0, 15).join(', ')}${f.uncovered.length > 15 ? `, and ${f.uncovered.length - 15} more ranges` : ''}`,
    ),
    '',
    `Before judging, read what the product promises for this area in docs/product/, its existing tests, and the code on those lines. Then, for each gap, say which it is and why: behaviour someone relies on that needs a test, dead code to delete, or not worth a test (wiring, a type, a log line). A file not worth a test is recorded with its reason in tools/test-explorer/not-worth-a-test.json by whoever builds the ticket, which moves it to the page's "Decided not to test" list.`,
    '',
    "For each test worth adding, give the rule and its cases in the product's language, the level it belongs at under the testing skill and docs/testing-strategy.md (the lowest level that can prove it), and the test file it goes in. Leave out any test that re-proves what a lower level already covers, and say where an existing level is missing entirely (for example an area with no F3 walk).",
    '',
    'Rank the suggestions by what an untested regression there would cost someone using Cockpit. Then ask me whether to file them as one unsliced ticket through the scoping skill.',
  ].join('\n');
}

/**
 * What the page carries for the spark icons of `areas`, the rows it draws:
 * each area a coverage run measured, with the figures the page shows for it
 * and everything inside it under the filters, and each file with lines no
 * test runs once, however many areas hold it.
 */
export function askData(model: Model, ix: Index, areas: Area[], q: Pick<TestsQuery, 'level' | 'package'>): AskData {
  const keep = keepOf(q);
  const files: AskFile[] = [];
  const at = new Map<string, number>();
  const place = (f: FileStatements) => {
    if (!at.has(f.file)) {
      at.set(f.file, files.length);
      files.push({ file: f.file, total: f.total, covered: f.covered, uncovered: f.uncovered ?? [] });
    }
    return at.get(f.file)!;
  };
  const out: Record<string, AskArea> = {};
  for (const a of areas) {
    const inside = [...walk([a])];
    const measured = model.coverageAvailable ? filesCovered(inside, keep) : null;
    const cover = coverageOf(measured);
    if (measured === null || cover === null) continue;
    const notRun = (f: FileStatements) => f.total - f.covered;
    const rules = deepRules(a, keep);
    out[a.key] = {
      label: a.label,
      where: [...pathOf(ix, a), a.label].join(' › '),
      inside: inside.slice(1).map((x) => x.label),
      files: measured
        .filter((f) => f.covered < f.total)
        .sort((x, y) => notRun(y) - notRun(x) || (x.file < y.file ? -1 : 1))
        .map(place),
      total: cover.total,
      covered: cover.covered,
      branches: branchGaps(inside, keep),
      levels: LEVELS.filter((l) => q.level === null || l.id === q.level).map((l) => (levelNotApplicable(model, a, l.id, true) ? `${l.id} n/a` : `${l.id} ${rules.filter((r) => r.level === l.id).length}`)),
    };
  }
  const qualifier = [q.level ? `${q.level} only` : '', q.package ? `${pkgLabel(q.package)} only` : ''].filter(Boolean).join(' · ');
  return { commit: model.commit, qualifier, files, areas: out };
}
