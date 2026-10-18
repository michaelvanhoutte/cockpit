//
// A run for one issue, for `pnpm cost:issue --run <number>`: a row per pull
// request of the issue and, where it is a parent, of its children, then a
// total. Pure - the issue, its sub-issues, the pull requests and the cost per
// branch are handed in; scripts/issue-cost.mjs does the `gh` and file reads.
//
// **A figure nothing recorded is `null`, never zero**, and a total that adds up
// rows where some had none says how many rows it is missing rather than
// reading short.
//

import { readBlock } from './session-record.mjs';

/** The words a figure takes in place of a number nothing recorded. */
export const NOT_RECORDED = 'not recorded';

/** A refusal in words, for the script to print and exit on. */
export class RunRefused extends Error {}

/** The issue a body names with a `Part of #N` line, or `null`. */
export function partOf(body) {
  const found = /^[ \t]*Part of #(\d+)/im.exec(String(body ?? ''));
  return found ? Number(found[1]) : null;
}

/** The issue a pull request belongs to: GitHub's closing reference where it gave one, else the `Part of #N` line. */
export function issueOfPullRequest(pr) {
  return pr.closingIssuesReferences?.[0]?.number ?? partOf(pr.body);
}

/**
 * Everything a run needs, read through the functions handed in, and refused in
 * words where one cannot be read: `readIssue(number)` answers `{ number, title }` or `null` for no such
 * issue, `readSubIssues(number)` the child numbers, `listPullRequests()` every pull request. Each may throw.
 */
export function readRunInputs(number, { readIssue, readSubIssues, listPullRequests }) {
  let issue;
  try {
    issue = readIssue(number);
  } catch (error) {
    throw new RunRefused(`could not read issue #${number} (${firstLine(error)})`);
  }
  if (!issue) throw new RunRefused(`there is no issue #${number}`);
  let subIssues;
  try {
    subIssues = readSubIssues(number);
  } catch (error) {
    throw new RunRefused(`could not read the sub-issues of #${number}, so its children are unknown (${firstLine(error)})`);
  }
  let pullRequests;
  try {
    pullRequests = listPullRequests();
  } catch (error) {
    throw new RunRefused(`could not read the pull requests (${firstLine(error)})`);
  }
  return { issue, subIssues, pullRequests };
}

const firstLine = (error) => String(error?.message ?? error).split('\n')[0];

const ms = (text) => (typeof text === 'string' ? Date.parse(text) : Number.NaN);
const span = (from, to) => (Number.isNaN(from) || Number.isNaN(to) || to < from ? null : to - from);

/** The marks of a body, or `null` where it has no session record (or one that cannot be read). */
function marksOf(body) {
  try {
    const marks = readBlock(String(body ?? ''));
    return marks.length === 0 ? null : marks.map((mark) => ({ ...mark, ms: ms(mark.at) })).filter((mark) => !Number.isNaN(mark.ms)).sort((a, b) => a.ms - b.ms);
  } catch {
    return null;
  }
}

/**
 * Each review round of a record: the `review-start`/`review-end` pair of one kind, with the next
 * `review-outcome` of that kind after the end. Time needs both ends; reported is the end's count; fixed and
 * declined are the outcome's. Anything missing is `null`.
 */
export function reviewsOf(marks) {
  const rounds = [];
  const open = new Map();
  for (const mark of marks) {
    const kind = mark.kind ?? 'code-review';
    if (mark.phase === 'review-start') {
      if (open.has(kind)) rounds.push(open.get(kind));
      open.set(kind, { kind, level: mark.level ?? null, startMs: mark.ms, endMs: null, reported: null, fixed: null, declined: null, ended: false });
    } else if (mark.phase === 'review-end') {
      const round = open.get(kind) ?? { kind, level: mark.level ?? null, startMs: null, endMs: null, reported: null, fixed: null, declined: null };
      open.delete(kind);
      round.endMs = mark.ms;
      round.level = round.level ?? mark.level ?? null;
      round.reported = mark.count ?? null;
      round.ended = true;
      rounds.push(round);
    } else if (mark.phase === 'review-outcome') {
      const round = [...rounds].reverse().find((r) => r.kind === kind && r.ended && r.fixed === null);
      if (round) {
        round.fixed = mark.fixed;
        round.declined = mark.declined;
      }
    }
  }
  rounds.push(...open.values());
  return rounds
    .sort((a, b) => (a.startMs ?? a.endMs) - (b.startMs ?? b.endMs))
    .map(({ kind, level, startMs, endMs, reported, fixed, declined }) => ({
      kind,
      level,
      startMs,
      endMs,
      ms: startMs === null || endMs === null ? null : span(startMs, endMs),
      reported,
      fixed,
      declined,
    }));
}

/** Each CI wait of a record: a `ci-start` and the `ci-end` after it. A start with no end has no time and no outcome. */
export function ciWaitsOf(marks) {
  const waits = [];
  let open = null;
  for (const mark of marks) {
    if (mark.phase === 'ci-start') {
      if (open) waits.push(open);
      open = { startMs: mark.ms, ms: null, outcome: null };
    } else if (mark.phase === 'ci-end' && open) {
      waits.push({ startMs: open.startMs, ms: span(open.startMs, mark.ms), outcome: mark.outcome });
      open = null;
    }
  }
  if (open) waits.push(open);
  return waits.map(({ ms: waited, outcome }) => ({ ms: waited, outcome }));
}

/** Coding time: from `scoped` (else `start`) to the first `pushed`, less the review rounds inside it. `null` where either end was not marked. */
export function codingMsOf(marks, reviews) {
  const first = (phase) => marks.find((mark) => mark.phase === phase)?.ms;
  const from = first('scoped') ?? first('start');
  const to = first('pushed');
  if (from === undefined || to === undefined) return null;
  const total = span(from, to);
  if (total === null) return null;
  const inside = reviews.filter((r) => r.startMs !== null && r.endMs !== null && r.startMs >= from && r.endMs <= to);
  return total - inside.reduce((sum, r) => sum + r.ms, 0);
}

/** The sum of figures, `null` where any is `null` or the list is itself `null`. */
const sumOrNull = (figures) => (figures === null || figures.some((n) => n === null) ? null : figures.reduce((sum, n) => sum + n, 0));

/** One pull request's row. `cost` is `{ costUSD, unpricedTokens }` from the local transcripts of its branch, or `undefined` where there are none. */
export function describePullRequest(pr, cost) {
  const marks = marksOf(pr.body);
  const reviews = marks === null ? null : reviewsOf(marks);
  const ci = marks === null ? null : ciWaitsOf(marks);
  const startMark = marks?.find((mark) => mark.phase === 'start');
  const merged = Boolean(pr.mergedAt);
  const endedAt = pr.mergedAt ?? pr.closedAt ?? null;
  return {
    issue: issueOfPullRequest(pr),
    pullRequest: { number: pr.number, branch: pr.headRefName, base: pr.baseRefName ?? null, state: merged ? 'merged' : String(pr.state ?? '').toLowerCase() },
    startedAt: startMark?.at ?? null,
    endedAt,
    codingMs: marks === null ? null : codingMsOf(marks, reviews),
    reviews,
    ci,
    figures: {
      reviewMs: sumOrNull(reviews === null ? null : reviews.map((r) => r.ms)),
      reported: sumOrNull(reviews === null ? null : reviews.map((r) => r.reported)),
      fixed: sumOrNull(reviews === null ? null : reviews.map((r) => r.fixed)),
      declined: sumOrNull(reviews === null ? null : reviews.map((r) => r.declined)),
      ciMs: sumOrNull(ci === null ? null : ci.map((wait) => wait.ms)),
      costUSD: cost ? cost.costUSD : null,
    },
    unpricedTokens: cost?.unpricedTokens ?? 0,
  };
}

const FIGURES = ['reviewMs', 'reported', 'fixed', 'declined', 'ciMs', 'costUSD'];

/** The total row: each figure added over the rows that have it, with how many rows had none. */
export function totalOf(rows) {
  const total = {};
  const column = (name, read) => {
    const known = rows.map(read).filter((n) => n !== null);
    total[name] = { value: known.reduce((sum, n) => sum + n, 0), missingRows: rows.length - known.length };
  };
  column('codingMs', (row) => row.codingMs);
  for (const name of FIGURES) column(name, (row) => row.figures[name]);
  return total;
}

/**
 * The run: `issue` (`{ number, title }`), the child numbers, every pull request and `costByBranch`
 * (a Map from branch to `{ costUSD, unpricedTokens }`). A row per pull request of the issue's children, then of
 * the issue itself; a child, or a plain issue, with no pull request yet is a row naming it with nothing recorded.
 */
export function buildRun({ issue, subIssues, pullRequests, costByBranch }) {
  const children = [...subIssues].sort((a, b) => a - b);
  const byIssue = new Map();
  for (const pr of [...pullRequests].sort((a, b) => a.number - b.number)) {
    const owner = issueOfPullRequest(pr);
    if (owner === null) continue;
    if (!byIssue.has(owner)) byIssue.set(owner, []);
    byIssue.get(owner).push(pr);
  }
  const rowsFor = (number, placeholder) => {
    const prs = byIssue.get(number) ?? [];
    if (prs.length === 0) return placeholder ? [emptyRow(number)] : [];
    return prs.map((pr) => describePullRequest(pr, costByBranch.get(pr.headRefName)));
  };
  const rows = [...children.flatMap((child) => rowsFor(child, true)), ...rowsFor(issue.number, children.length === 0)];
  return { issue: { number: issue.number, title: issue.title ?? '' }, children, rows, total: totalOf(rows) };
}

function emptyRow(issue) {
  return {
    issue,
    pullRequest: null,
    startedAt: null,
    endedAt: null,
    codingMs: null,
    reviews: null,
    ci: null,
    figures: { reviewMs: null, reported: null, fixed: null, declined: null, ciMs: null, costUSD: null },
    unpricedTokens: 0,
  };
}

/** A duration as `1h5m` or `12m`, or the words for none. */
export function showDuration(value) {
  if (value === null || value === undefined) return NOT_RECORDED;
  const minutes = Math.round(value / 60000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60}m` : `${minutes}m`;
}

/** A count, or the words for none. */
export const showCount = (value) => (value === null || value === undefined ? NOT_RECORDED : String(value));

/** Dollars, or the words for none. */
export const showCost = (value) => (value === null || value === undefined ? NOT_RECORDED : `$${value.toFixed(2)}`);

/** A total's figure: the sum, and where rows had none, how many - so it never reads short without saying. */
export function showTotal(figure, show) {
  const missing = figure.missingRows === 0 ? '' : ` (missing ${figure.missingRows} row${figure.missingRows === 1 ? '' : 's'}: ${NOT_RECORDED})`;
  return `${show(figure.value)}${missing}`;
}
