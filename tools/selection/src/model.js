/**
 * The numbers, and nothing else. Takes what github.js fetched — each pull
 * request's own last Test run and `main`'s run of its merge — and returns the
 * model the renderer draws: no I/O, and no clock of its own, so a window
 * boundary is something a test can put anywhere it likes.
 *
 * **A pull request is one of three things**: `ran` (its Test job uploaded a
 * record — the ordinary case), `docs-only` (no record, and its diff is
 * documentation only — the Test job never started, per ci.yml's own gate) or
 * `no-record` (no record and no such excuse — expired, or the job failed to
 * upload one). Only `ran` and `docs-only` pull requests can carry a miss; a
 * `no-record` one is counted in neither direction, because there is no way to
 * tell what it would have done.
 *
 * **A miss is a test file that failed on `main`'s run of a merge that the
 * merged pull request's own last run did not run.** Read against the record
 * `main`'s own push run wrote for the same commit, never against a second
 * guess at what should have run.
 */

import { ownersText } from '../../../scripts/lib/e2e-record.mjs';
import { productChanged } from '../../../scripts/lib/what-changed.mjs';
import { openAlarmNumbers } from './alarm.js';

const DAY_MS = 86_400_000;

/**
 * The bars: the one place their numbers live, so the page and the
 * harness-cost-review skill read the same ones. A bar is read on the
 * `windowDays` window only, and only once that window holds `minPulls` merged
 * pull requests; the figures in the other windows are shown, never judged.
 */
export const BARS = Object.freeze({
  windowDays: 14,
  minPulls: 20,
  /** A job forced to run everything on this share of the pull requests that ran it, Test and E2E apart. */
  forcedFull: 0.25,
  /** A test file or spec selected on this share of the pull requests that could have skipped it, over at least `minOver` of them. */
  mostSelected: Object.freeze({ share: 0.8, minOver: 10 }),
  /** Misses: any one crosses. */
  misses: 1,
});

/** Each bar with its name and the numbers it is read against: what the page draws, and what the Harness Monitor is sent so its verdicts are judged against the same ones. */
export const BAR_DEFS = Object.freeze([
  { id: 'e2e-forced-full', name: 'E2E forced to run every spec', threshold: BARS.forcedFull, minOver: null },
  { id: 'test-forced-full', name: 'Test forced to run everything', threshold: BARS.forcedFull, minOver: null },
  { id: 'misses', name: 'Misses', threshold: BARS.misses, minOver: null },
  { id: 'most-selected', name: 'A test selected on nearly every pull request', threshold: BARS.mostSelected.share, minOver: BARS.mostSelected.minOver },
]);

const barName = (id) => BAR_DEFS.find((def) => def.id === id).name;

const time = (text) => {
  const ms = Date.parse(text ?? '');
  return Number.isFinite(ms) ? ms : null;
};

/** Median of a set of numbers — the middle one, or the average of the middle two on an even count. `null` for none, which is "none", not zero. */
export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[Math.floor(mid)];
}

/** A selection in words: `itself changed`, the path sequence a Vitest file was reached through, the honest "no chain found" for a file Vitest selected on a trigger this graph does not carry, or the concept and changed file that selected an E2E spec. */
export function chainText(selectedBy) {
  if (!selectedBy) return 'selected by Vitest; no import chain found';
  if (selectedBy.kind === 'itself') return 'itself changed';
  if (selectedBy.kind === 'concept') return ownersText(selectedBy);
  return selectedBy.chain.join(' → ');
}

/** Every file across a record's packages that failed — the level comes from the record, which is where it is derived once (test-record.mjs's `testLevel`). */
function failedFiles(record) {
  if (!record) return [];
  return record.packages.flatMap((pkg) => pkg.files.filter((file) => file.status === 'failed').map((file) => ({ path: file.path, level: file.level })));
}

/**
 * The package `path` belongs to: the one whose own file list carries it, or —
 * for a package whose process crashed before writing one (`report: 'none'`,
 * always an empty file list, so it can never match that way) — the one whose
 * own directory contains it. `null` where neither finds one, a genuine gap
 * this report cannot explain away.
 */
function owningPackage(record, path) {
  return record.packages.find((pkg) => pkg.files.some((file) => file.path === path)) ?? record.packages.find((pkg) => path.startsWith(`${pkg.dir}/`)) ?? null;
}

/**
 * The misses a pull request accounts for: `main`'s failures its own run
 * either explains (ran the file, or ran its package in full) or does not.
 *
 * A `docs-only` pull request explains none of them — its Test job never
 * ran anything — so every one of `main`'s failures is a miss for it, tagged
 * `docs only`. A `no-record` pull request explains nothing either way, and
 * Rule 1's own table is explicit that such a pull request is "counted neither
 * way": it contributes no misses at all, not even docs-only ones.
 */
function missesOf(status, prRecord, mainRecord) {
  const failures = failedFiles(mainRecord);
  if (failures.length === 0 || status === 'no-record') return [];
  if (status === 'docs-only') return failures.map((failure) => ({ ...failure, reason: 'docs only' }));

  const misses = [];
  for (const failure of failures) {
    const owner = owningPackage(prRecord, failure.path);
    if (!owner || owner.report === 'none') {
      // No owning package at all is a gap this report cannot explain away, so
      // it is named as a miss; a package whose process crashed before writing
      // a report (`owner.report === 'none'`) is the opposite kind of gap —
      // there is no telling what it ran — and is left out of both counts.
      if (!owner) misses.push({ ...failure, reason: null });
      continue;
    }
    if (owner.mode === 'full') continue;
    const entry = owner.files.find((file) => file.path === failure.path);
    if (!entry || entry.status === 'not run') misses.push({ ...failure, reason: null });
  }
  return misses;
}

/** The distinct `{ rule, path }` reasons that forced any of this record's packages to run in full — each package's own reason once, even where several packages share the same one (a lockfile change forces every package identically). */
function forcedFullReasons(record) {
  const seen = new Set();
  const reasons = [];
  for (const pkg of record.packages) {
    if (pkg.mode !== 'full' || !pkg.reason) continue;
    const key = `${pkg.reason.rule}\u0000${pkg.reason.path ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    reasons.push(pkg.reason);
  }
  return reasons;
}

const filesRunCount = (record) => record.packages.reduce((total, pkg) => total + pkg.files.filter((file) => file.status !== 'not run').length, 0);

/**
 * The E2E half of one pull request, read from the record the E2E job wrote
 * (scripts/lib/e2e-record.mjs), which has the Test record's shape - the whole
 * tier as one package, each spec file one of its files - so the functions above
 * read it as they read that one. `docs-only` follows the pull request's own
 * status (the job never started); a product pull request with no record is
 * `no-record`, which is every one from before E2E recorded anything.
 */
function e2eModel(status, prE2e, mainE2e) {
  const e2eStatus = prE2e ? 'ran' : status === 'docs-only' ? 'docs-only' : 'no-record';
  const misses = missesOf(e2eStatus, prE2e, mainE2e);
  if (e2eStatus !== 'ran') return { status: e2eStatus, misses, packages: [], filesRun: null, filesTotal: null, forcedFull: [], ranEverything: false, selecting: false };

  const ranEverything = prE2e.packages.length > 0 && prE2e.packages.every((pkg) => pkg.mode === 'full');
  return {
    status: e2eStatus,
    misses,
    packages: prE2e.packages,
    filesRun: filesRunCount(prE2e),
    filesTotal: prE2e.packages.reduce((total, pkg) => total + pkg.files.length, 0),
    forcedFull: forcedFullReasons(prE2e),
    ranEverything,
    selecting: !ranEverything,
  };
}

/** @param {import('./github.js').PullData} pullData */
export function pullModel({ pull, prRun, mainRun, files }) {
  const prRecord = prRun?.record ?? null;
  const mainRecord = mainRun?.record ?? null;
  // Documentation only where its diff was read and found to touch nothing the
  // mechanical checks do (the same `productChanged` ci.yml's own classifier
  // calls); `files` is null only when a record was already found, so this
  // branch is reached only where there is a diff to read.
  const status = prRecord ? 'ran' : productChanged(files ?? []) ? 'no-record' : 'docs-only';

  const e2e = e2eModel(status, prRun?.e2eRecord ?? null, mainRun?.e2eRecord ?? null);

  const base = {
    number: pull.number,
    title: pull.title,
    url: pull.url,
    mergedAt: pull.mergedAt,
    status,
    testDurationMs: { pr: prRun?.testDurationMs ?? null, main: mainRun?.testDurationMs ?? null },
    // One list for both tiers: an E2E miss is told apart by its `level`, `e2e`.
    misses: [...missesOf(status, prRecord, mainRecord), ...e2e.misses],
    e2e,
  };

  if (status !== 'ran') {
    return { ...base, changedFiles: (files ?? []).map((path) => ({ path, ignored: false })), packages: [], filesRun: null, forcedFull: [], ranEverything: false, selecting: false };
  }

  const ranEverything = prRecord.packages.length > 0 && prRecord.packages.every((pkg) => pkg.mode === 'full');
  return {
    ...base,
    changedFiles: prRecord.changedFiles,
    packages: prRecord.packages,
    filesRun: filesRunCount(prRecord),
    forcedFull: forcedFullReasons(prRecord),
    ranEverything,
    selecting: !ranEverything,
  };
}

const refOf = (pull) => ({ number: pull.number, title: pull.title, url: pull.url, mergedAt: pull.mergedAt });

/** The pull requests merged in the last `days` days up to `now`. */
function pullsInWindow(pulls, days, now) {
  const since = now.getTime() - days * DAY_MS;
  return pulls.filter((pull) => {
    const merged = time(pull.mergedAt);
    return merged !== null && merged >= since && merged <= now.getTime();
  });
}

/**
 * The test file or spec selected on the largest share of the pull requests
 * that could have skipped it, among those with at least `BARS.mostSelected.minOver`
 * such pull requests. A pull request could have skipped a file only where its
 * package (or the E2E tier) ran in `changed` mode; a full run says nothing
 * about selection. `null` where no file has ten of them.
 */
function mostSelectedShare(pulls) {
  const files = new Map();
  const tally = (packages) => {
    for (const pkg of packages) {
      if (pkg.mode === 'full') continue;
      for (const file of pkg.files) {
        const entry = files.get(file.path) ?? { path: file.path, selected: 0, of: 0 };
        entry.of += 1;
        if (file.status !== 'not run') entry.selected += 1;
        files.set(file.path, entry);
      }
    }
  };
  for (const pull of pulls) {
    tally(pull.packages);
    tally(pull.e2e.packages);
  }

  const eligible = [...files.values()].filter((entry) => entry.of >= BARS.mostSelected.minOver).map((entry) => ({ ...entry, share: entry.selected / entry.of }));
  eligible.sort((a, b) => b.share - a.share || b.of - a.of || a.path.localeCompare(b.path));
  return eligible[0] ?? null;
}

/**
 * One window's summary — the five figures "Is selection working?" asks for.
 * `null` wherever there is nothing to compute from, which the page reads as
 * "none" and never draws as a zero it did not earn.
 */
function windowSummary(pulls, { days, now, coveredSince }) {
  const since = now.getTime() - days * DAY_MS;
  const inWindow = pullsInWindow(pulls, days, now);
  const partial = coveredSince.getTime() > since;

  const ran = inWindow.filter((pull) => pull.status === 'ran');
  const docsOnly = inWindow.filter((pull) => pull.status === 'docs-only');
  const forcedFullPulls = ran.filter((pull) => pull.ranEverything);
  const selecting = ran.filter((pull) => pull.selecting);
  const e2eRan = inWindow.filter((pull) => pull.e2e.status === 'ran');
  const e2eSelecting = e2eRan.filter((pull) => pull.e2e.selecting);
  const missCount = inWindow.reduce((total, pull) => total + pull.misses.length, 0);

  return {
    days,
    since: new Date(since).toISOString(),
    partial,
    actualDays: partial ? (now.getTime() - coveredSince.getTime()) / DAY_MS : days,
    pulls: inWindow.length,
    misses: inWindow.length === 0 ? null : missCount,
    // Of the pull requests that ran a Test job at all — a documentation-only or
    // no-record one never had the chance to be forced full or to select, so
    // counting it in the denominator would understate how often the ones that
    // did run paid the full-run cost.
    forcedFull: ran.length === 0 ? null : { count: forcedFullPulls.length, of: ran.length },
    // null where nothing here ever used selection — a window every pull request
    // ran in full has no "typical" selecting pull request to measure.
    typicalFiles: selecting.length === 0 ? null : median(selecting.map((pull) => pull.filesRun)),
    duration: {
      pr: inWindow.length === 0 ? null : median(ran.map((pull) => pull.testDurationMs.pr).filter((ms) => ms !== null)),
      main: inWindow.length === 0 ? null : median(ran.map((pull) => pull.testDurationMs.main).filter((ms) => ms !== null)),
    },
    docsOnly: inWindow.length === 0 ? null : { count: docsOnly.length, of: inWindow.length },
    // The worst test file or spec by share selected, over the pull requests that could have skipped it; null where none has ten of them.
    mostSelected: mostSelectedShare(inWindow),
    // The browser tier, counted over the pull requests whose E2E job left a
    // record: one from before E2E recorded anything says nothing either way.
    e2e: {
      forcedFull: e2eRan.length === 0 ? null : { count: e2eRan.filter((pull) => pull.e2e.ranEverything).length, of: e2eRan.length },
      typicalSpecs: e2eSelecting.length === 0 ? null : median(e2eSelecting.map((pull) => pull.e2e.filesRun)),
    },
  };
}

/** Every distinct `{ rule, path }` that forced a full run, across every pull request that has one, worst (most pull requests) first. */
function forcedFullTable(pulls, forcedOf = (pull) => pull.forcedFull) {
  const rows = new Map();
  for (const pull of pulls) {
    for (const reason of forcedOf(pull)) {
      const key = `${reason.rule}\u0000${reason.path ?? ''}`;
      if (!rows.has(key)) rows.set(key, { rule: reason.rule, path: reason.path, pulls: [] });
      rows.get(key).pulls.push(refOf(pull));
    }
  }
  return [...rows.values()].map((row) => ({ ...row, count: row.pulls.length })).sort((a, b) => b.count - a.count);
}

/** The two jobs this report reads, each with how to tell a pull request ran it, what forced it and whether it ran everything. `Vitest` is the Test job's name on the page. */
const TIERS = [
  { tier: 'Vitest', ran: (pull) => pull.status === 'ran', forcedOf: (pull) => pull.forcedFull, ranEverything: (pull) => pull.ranEverything },
  { tier: 'E2E', ran: (pull) => pull.e2e.status === 'ran', forcedOf: (pull) => pull.e2e.forcedFull, ranEverything: (pull) => pull.e2e.ranEverything },
];

/** A share against its bar. Unread wherever the window is too small or the figure cannot be given, never within. The tolerance keeps 29 of 116 (exactly a quarter) on the right side of a float. */
function verdictOf({ read, value, threshold }) {
  if (!read || value === null) return 'unread';
  return value + 1e-9 >= threshold ? 'crossed' : 'within';
}

const share = (count, of) => (of > 0 ? count / of : null);

/**
 * A row per rule that forced a full run, above the paths it caught. A pull
 * request is counted once per rule however many of its paths that rule caught,
 * and once for each of two rules that both caught it. Each row is read against
 * the forced-full bar by its own total (the pull requests it left running everything), because one rule spread over a hundred
 * new files is one cause that no single path reaches the bar for.
 *
 * Over `windowPulls` (the bar window), so a row's figures and the bar they
 * cross are counted over the same pull requests. Worst (most pull requests)
 * first, and each rule's paths worst first.
 */
function forcedFullRules(windowPulls, read) {
  const rows = [];
  for (const { tier, ran, forcedOf, ranEverything } of TIERS) {
    const ranPulls = windowPulls.filter(ran);
    const byRule = new Map();
    for (const pull of ranPulls) {
      for (const reason of forcedOf(pull)) {
        const entry = byRule.get(reason.rule) ?? { pulls: new Map(), everything: new Set(), paths: new Map() };
        byRule.set(reason.rule, entry);
        entry.pulls.set(pull.number, refOf(pull));
        if (ranEverything(pull)) entry.everything.add(pull.number);
        const pathEntry = entry.paths.get(reason.path) ?? { path: reason.path, pulls: [] };
        entry.paths.set(reason.path, pathEntry);
        pathEntry.pulls.push(refOf(pull));
      }
    }
    for (const [rule, entry] of byRule) {
      // The bar is about running everything: a rule that forced one package of several is listed, but only the pull requests it left running everything are read against the bar.
      const value = share(entry.everything.size, ranPulls.length);
      rows.push({
        tier,
        rule,
        count: entry.pulls.size,
        of: ranPulls.length,
        share: share(entry.pulls.size, ranPulls.length),
        verdict: verdictOf({ read, value, threshold: BARS.forcedFull }),
        pulls: [...entry.pulls.values()],
        paths: [...entry.paths.values()].map((each) => ({ ...each, count: each.pulls.length })).sort((a, b) => b.count - a.count || String(a.path).localeCompare(String(b.path))),
      });
    }
  }
  const tierOrder = TIERS.map((each) => each.tier);
  return rows.sort((a, b) => b.count - a.count || tierOrder.indexOf(a.tier) - tierOrder.indexOf(b.tier) || a.rule.localeCompare(b.rule));
}

/** Of the pull requests that ran everything, the rule that forced the most of them (a pull request counted once per rule), or null where none names one. */
function leadingRule(pulls, forcedOf) {
  const tally = new Map();
  for (const pull of pulls) {
    for (const rule of new Set(forcedOf(pull).map((reason) => reason.rule))) tally.set(rule, (tally.get(rule) ?? 0) + 1);
  }
  const [leader] = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return leader ? { rule: leader[0], count: leader[1] } : null;
}

/**
 * The bars, read on the 14-day window. Each names its figure (`count` of `of`,
 * and `value` the number the bar compares), its `threshold`, and a `verdict`:
 * `crossed`, `within`, or `unread` — `unread` for `window` (fewer than
 * `BARS.minPulls` merged pull requests) or `figure` (the window cannot give it).
 * A partial window is read by its actual days and says so (`partial`).
 *
 * `alarmIssue` is the number of the bar's open alarm issue (the newest, where
 * several are open), or null: the page links it. It is set from the alarms the
 * run read before building, so a bar the nightly job files tonight is linked
 * on tomorrow's page.
 */
function barsOf(windowPulls, summary, alarmNumbers) {
  const read = summary.pulls >= BARS.minPulls;
  const bar = ({ id, name, count, of, value, threshold, ...extra }) => {
    const verdict = verdictOf({ read, value, threshold });
    return { id, name, count, of, value, threshold, minOver: null, path: null, cause: null, ...extra, verdict, unread: verdict !== 'unread' ? null : read ? 'figure' : 'window', alarmIssue: alarmNumbers.get(id) ?? null };
  };
  const forced = (id, name, figure, { forcedOf, ranEverything, ran }) =>
    bar({
      id,
      name,
      count: figure?.count ?? null,
      of: figure?.of ?? null,
      value: figure ? share(figure.count, figure.of) : null,
      threshold: BARS.forcedFull,
      cause: leadingRule(windowPulls.filter((pull) => ran(pull) && ranEverything(pull)), forcedOf),
    });
  const [test, e2e] = TIERS;
  const selected = summary.mostSelected;

  return {
    windowDays: BARS.windowDays,
    minPulls: BARS.minPulls,
    pulls: summary.pulls,
    partial: summary.partial,
    actualDays: summary.actualDays,
    read,
    items: [
      forced('e2e-forced-full', barName('e2e-forced-full'), summary.e2e.forcedFull, e2e),
      forced('test-forced-full', barName('test-forced-full'), summary.forcedFull, test),
      bar({ id: 'misses', name: barName('misses'), count: summary.misses, of: null, value: summary.misses, threshold: BARS.misses }),
      bar({
        id: 'most-selected',
        name: barName('most-selected'),
        count: selected?.selected ?? null,
        of: selected?.of ?? null,
        value: selected?.share ?? null,
        threshold: BARS.mostSelected.share,
        minOver: BARS.mostSelected.minOver,
        path: selected?.path ?? null,
      }),
    ],
  };
}

/**
 * Every test file selected at least once, or run because its package was
 * full, across every `ran` pull request — most selected first.
 *
 * `selectingPulls` counts a pull request only where the file's package ran in
 * `changed` mode at all, whether or not it picked this file: the denominator
 * is the pull requests that had the *opportunity* to select it. `fullRunPulls`
 * is tracked apart, since a full-mode run says nothing about selection.
 */
function mostSelectedTable(pulls, limit) {
  const files = new Map();
  const entryFor = (path, level) => {
    if (!files.has(path)) files.set(path, { path, level, selectingPulls: 0, selectedPulls: 0, fullRunPulls: 0, chains: new Map() });
    return files.get(path);
  };

  for (const pull of pulls) {
    for (const pkg of pull.packages) {
      for (const file of pkg.files) {
        const entry = entryFor(file.path, file.level);
        const ran = file.status !== 'not run';
        if (pkg.mode === 'full') {
          if (ran) entry.fullRunPulls += 1;
          continue;
        }
        entry.selectingPulls += 1;
        if (ran) {
          entry.selectedPulls += 1;
          const text = chainText(file.selectedBy);
          entry.chains.set(text, (entry.chains.get(text) ?? 0) + 1);
        }
      }
    }
  }

  return [...files.values()]
    .filter((entry) => entry.selectedPulls > 0 || entry.fullRunPulls > 0)
    .map((entry) => ({
      path: entry.path,
      level: entry.level,
      selectedPulls: entry.selectedPulls,
      selectingPulls: entry.selectingPulls,
      fullRunPulls: entry.fullRunPulls,
      // Ties keep the first chain seen (Array#sort is stable): "either is
      // correct" is this report's own answer for that case (see the issue's
      // cut list), not a claim that one chain mattered more.
      mostCommonChain: [...entry.chains.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    }))
    .sort((a, b) => b.selectedPulls - a.selectedPulls || b.fullRunPulls - a.fullRunPulls)
    .slice(0, limit);
}

/**
 * @param {object} input
 * @param {import('./github.js').PullData[]} input.pulls
 * @param {Date} input.now
 * @param {number} input.requestedDays how far back the fetch was asked to go
 * @param {Date} input.coveredSince how far back the listing was actually read
 * @param {boolean} [input.truncated] whether the pull budget stopped the fetch short
 * @param {number[]} [input.windows] the windows "Is selection working?" reports, in days
 * @param {number} [input.limit] how many rows the most-selected table carries
 * @param {{ number: number, state: string, body: string }[]} [input.alarms] the repository's alarm issues, for each bar's `alarmIssue`
 */
export function buildModel({ pulls: pullData, now, requestedDays, coveredSince, truncated = false, repo, branch = 'main', commit = null, windows = [7, 14], limit = 15, alarms = [] }) {
  const pulls = pullData.map(pullModel).sort((a, b) => time(b.mergedAt) - time(a.mergedAt));
  const requestedSince = now.getTime() - requestedDays * DAY_MS;
  const barWindowPulls = pullsInWindow(pulls, BARS.windowDays, now);
  const windowSummaries = windows.map((days) => windowSummary(pulls, { days, now, coveredSince }));
  const barSummary = windowSummaries.find((each) => each.days === BARS.windowDays) ?? windowSummary(pulls, { days: BARS.windowDays, now, coveredSince });
  const bars = barsOf(barWindowPulls, barSummary, openAlarmNumbers(alarms));

  return {
    repo,
    branch,
    commit,
    generatedAt: now.toISOString(),
    coverage: {
      requestedDays,
      since: new Date(requestedSince).toISOString(),
      until: now.toISOString(),
      coveredSince: coveredSince.toISOString(),
      actualDays: Math.min(requestedDays, (now.getTime() - coveredSince.getTime()) / DAY_MS),
      partial: coveredSince.getTime() > requestedSince,
      truncated,
      pulls: pulls.length,
    },
    windows: windowSummaries,
    bars,
    // A row per rule above its paths, over the bar window: the page's "What forced a full run".
    forcedFullRules: forcedFullRules(barWindowPulls, bars.read),
    misses: pulls.flatMap((pull) => pull.misses.map((miss) => ({ ...miss, pull: refOf(pull) }))),
    forcedFull: forcedFullTable(pulls.filter((pull) => pull.status === 'ran')),
    // The browser tier's own rules, apart from the Test job's: "push to main" forces both, and is two reasons.
    e2eForcedFull: forcedFullTable(
      pulls.filter((pull) => pull.e2e.status === 'ran'),
      (pull) => pull.e2e.forcedFull,
    ),
    mostSelected: mostSelectedTable(
      pulls.filter((pull) => pull.status === 'ran'),
      limit,
    ),
    pulls,
  };
}

/** The most misses of one pull request, and characters of a chain in words, that the Monitor takes (apps/harness-monitor/src/selection.ts): it refuses a whole batch past either, which would hold every later night back. */
const KEPT_MISSES = 500;
const KEPT_TEXT = 2000;

/** Why a file ran, as the Harness Monitor stores it: a kind, and for a chain or a concept the structure and its words. A file of a package that ran everything was not picked. */
function selectedByRow(selectedBy, mode) {
  if (mode === 'full') return { kind: 'full' };
  const words = (value) => chainText(value).slice(0, KEPT_TEXT);
  if (!selectedBy) return { kind: 'unknown', text: words(null) };
  if (selectedBy.kind === 'itself') return { kind: 'itself', text: words(selectedBy) };
  if (selectedBy.kind === 'concept') return { kind: 'concept', owners: selectedBy.owners, text: words(selectedBy) };
  return { kind: 'chain', chain: selectedBy.chain, text: words(selectedBy) };
}

/** A package as the Monitor stores it: only the files the job ran, each with why, and how many files it holds in all. */
function packageRow(pkg) {
  return {
    name: pkg.name,
    dir: pkg.dir,
    mode: pkg.mode,
    report: pkg.report,
    reason: pkg.reason ? { rule: pkg.reason.rule, path: pkg.reason.path ?? null } : null,
    // A package whose process wrote no report lists no files, which is not that it holds none.
    filesTotal: pkg.report === 'none' ? null : pkg.files.length,
    files: pkg.files.filter((file) => file.status !== 'not run').map((file) => ({ path: file.path, level: file.level, status: file.status, selectedBy: selectedByRow(file.selectedBy, pkg.mode) })),
  };
}

const filesTotalOf = (packages) => packages.reduce((total, pkg) => total + pkg.files.length, 0);

/** How many changed files the browser tier's selection placed on no walk, or null where its record does not say (a Test job has none, and an older record carries no list). */
const unplacedOf = (packages) => (packages.some((pkg) => Array.isArray(pkg.unplaced)) ? packages.reduce((total, pkg) => total + (pkg.unplaced?.length ?? 0), 0) : null);

/**
 * The pull requests as the Harness Monitor stores them: for each, a row per job
 * (Test, E2E) with its status, what it ran and why, its changed files and its
 * packages, and the misses of both. A job that did not run says nothing about
 * what it ran. Only the files a job ran are sent, since what a test could have
 * skipped is told by the packages that selected.
 *
 * @param {object} input
 * @param {import('./github.js').PullData[]} input.pulls
 */
export function monitorRows({ pulls: pullData }) {
  return pullData
    .filter((data) => time(data.pull.mergedAt) !== null)
    .map((data) => {
      const pull = pullModel(data);
      const ran = pull.status === 'ran';
      const e2eRan = pull.e2e.status === 'ran';
      return {
        number: pull.number,
        title: pull.title,
        url: pull.url,
        mergedAt: pull.mergedAt,
        jobs: [
          {
            job: 'test',
            status: pull.status,
            ranEverything: pull.ranEverything,
            selecting: pull.selecting,
            filesRun: ran ? pull.filesRun : null,
            filesTotal: ran ? filesTotalOf(pull.packages) : null,
            prDurationMs: pull.testDurationMs.pr,
            mainDurationMs: pull.testDurationMs.main,
            unplacedFiles: null,
            changedFiles: pull.changedFiles,
            packages: pull.packages.map(packageRow),
          },
          {
            job: 'e2e',
            status: pull.e2e.status,
            ranEverything: pull.e2e.ranEverything,
            selecting: pull.e2e.selecting,
            filesRun: e2eRan ? pull.e2e.filesRun : null,
            filesTotal: e2eRan ? pull.e2e.filesTotal : null,
            prDurationMs: null,
            mainDurationMs: null,
            unplacedFiles: e2eRan ? unplacedOf(pull.e2e.packages) : null,
            // The browser tier's own record names the diff it read; a run without one read the same diff the Test job did.
            changedFiles: data.prRun?.e2eRecord?.changedFiles ?? pull.changedFiles,
            packages: pull.e2e.packages.map(packageRow),
          },
        ],
        misses: pull.misses.slice(0, KEPT_MISSES).map((miss) => ({ job: miss.level === 'e2e' ? 'e2e' : 'test', path: miss.path, level: miss.level, reason: miss.reason ?? null })),
      };
    });
}

/**
 * The bars' thresholds as the Monitor is sent them, with each bar's open alarm
 * issue. `alarms` is the repository's alarm issues, or undefined where they
 * could not be read, in which case none is sent and the Monitor keeps the ones
 * it holds: a failed read must not clear an alarm the cost review is reading.
 *
 * @param {{ alarms?: { number: number, state: string, body: string }[] }} [input]
 */
export function monitorBars({ alarms } = {}) {
  const open = alarms ? openAlarmNumbers(alarms) : null;
  return {
    windowDays: BARS.windowDays,
    minPulls: BARS.minPulls,
    items: BAR_DEFS.map((def) => ({ ...def, ...(open ? { alarmIssue: open.get(def.id) ?? null } : {}) })),
  };
}
