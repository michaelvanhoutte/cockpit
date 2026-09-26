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

const DAY_MS = 86_400_000;

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

/**
 * One window's summary — the five figures "Is selection working?" asks for.
 * `null` wherever there is nothing to compute from, which the page reads as
 * "none" and never draws as a zero it did not earn.
 */
function windowSummary(pulls, { days, now, coveredSince }) {
  const since = now.getTime() - days * DAY_MS;
  const inWindow = pulls.filter((pull) => {
    const merged = time(pull.mergedAt);
    return merged !== null && merged >= since && merged <= now.getTime();
  });
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
 */
export function buildModel({ pulls: pullData, now, requestedDays, coveredSince, truncated = false, repo, branch = 'main', commit = null, windows = [7, 14], limit = 15 }) {
  const pulls = pullData.map(pullModel).sort((a, b) => time(b.mergedAt) - time(a.mergedAt));
  const requestedSince = now.getTime() - requestedDays * DAY_MS;

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
    windows: windows.map((days) => windowSummary(pulls, { days, now, coveredSince })),
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
