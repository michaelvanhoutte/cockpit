//
// The I/O around scripts/lib/issue-cost.mjs, for `pnpm cost:issue`. Everything
// that decides anything is in the module; this locates Claude Code's own log
// directory, resolves an issue for a branch that does not name one itself,
// and prints what it is told.
//
// Usage:
//   pnpm cost:issue                       every issue with a line since the beginning
//   pnpm cost:issue --since 2026-08-15    every issue with a line on or after that date
//   pnpm cost:issue --issue 421           one issue only
//   pnpm cost:issue --json                machine-readable, for storing a comparison
//   pnpm cost:issue --run 1258            a run: a row per pull request of that issue and, for a parent, its
//                                         children (found through sub-issues, closing references and `Part of #N`
//                                         lines), each with start and end, coding time, every review's time with
//                                         reported/fixed/declined, every CI wait's time and outcome and token
//                                         cost, then a total. What nothing recorded reads "not recorded". Takes
//                                         --json; not --since or --issue.
//
// Issue 421's own baseline: run over the month since 15 August 2026, this
// should land close to about 52,000 requests, 422 subagent transcripts and
// about $8,500 - the figures measured by hand before this existed.
//

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { readFlags } from './lib/operator.mjs';
import { buildReport, marksByBranch, thisRepoProjectDirs } from './lib/issue-cost.mjs';
import { NOT_RECORDED, RunRefused, buildRun, readRunInputs, showCost, showCount, showDuration, showTotal } from './lib/issue-run.mjs';

let args;
try {
  args = readFlags(process.argv.slice(2), {
    takes: { '--since': 'since', '--issue': 'only', '--run': 'run' },
    switches: { '--json': 'json' },
  });
} catch (error) {
  console.error(`${error.message}

  pnpm cost:issue [--since <date>] [--issue <number>] [--json]
  pnpm cost:issue --run <number> [--json]`);
  process.exit(2);
}

if (args.run !== undefined && (args.since || args.only || !/^\d+$/.test(args.run))) {
  console.error('--run takes one issue number, and not --since or --issue');
  process.exit(2);
}

let sinceMs = null;
if (args.since) {
  sinceMs = Date.parse(args.since);
  if (Number.isNaN(sinceMs)) {
    console.error(`--since ${args.since} is not a date this can read - try 2026-08-15`);
    process.exit(2);
  }
}

const only = args.only ? (/^\d+$/.test(args.only) ? Number(args.only) : args.only) : null;

// `--path-format=absolute` (git 2.31+), because plain `--git-common-dir` answers a bare relative
// `.git` when run from the main checkout's own root - the one place a relative answer is possible.
const repoRoot = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' })
  .trim()
  .replace(/[/\\]\.git$/, '');

const claudeDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
const projectsDir = join(claudeDir, 'projects');
if (!existsSync(projectsDir)) {
  console.error(`no session logs at ${projectsDir} - is this the machine that ran the work?`);
  process.exit(1);
}
const projectDirs = thisRepoProjectDirs(repoRoot, projectsDir);

if (args.run !== undefined) {
  runRun(Number(args.run));
  process.exit(0);
}

const { resolveIssue, resolveMarks, marksUnreadable } = makeIssueResolver(repoRoot);
const report = buildReport({ projectDirs, resolveIssue, resolveMarks, marksUnreadable, since: sinceMs, only });

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printTable(report);
}

/** Prints the run for an issue; refused in words where the issue, its sub-issues or the pull requests cannot be read. */
function runRun(number) {
  let inputs;
  try {
    inputs = readRunInputs(number, {
      readIssue: (n) => {
        try {
          return JSON.parse(gh(['issue', 'view', String(n), '--json', 'number,title']));
        } catch (error) {
          if (/Could not resolve to an issue|not found/i.test(String(error?.stderr ?? error?.message))) return null;
          throw error;
        }
      },
      readSubIssues: (n) =>
        gh(['api', `repos/{owner}/{repo}/issues/${n}/sub_issues`, '--paginate', '--jq', '.[].number'])
          .split(/\s+/)
          .filter(Boolean)
          .map(Number),
      listPullRequests: () =>
        listPullRequests(repoRoot, 'number,headRefName,baseRefName,state,createdAt,mergedAt,closedAt,body,closingIssuesReferences'),
    });
  } catch (error) {
    if (!(error instanceof RunRefused)) throw error;
    console.error(error.message);
    process.exit(1);
  }

  const branches = new Set(inputs.pullRequests.map((pr) => pr.headRefName));
  const costByBranch = new Map();
  const perBranch = buildReport({ projectDirs, byBranch: true });
  for (const entry of perBranch.issues) {
    if (branches.has(entry.issue)) costByBranch.set(entry.issue, { costUSD: entry.costUSD.total, unpricedTokens: entry.unpricedTokens });
  }

  const run = buildRun({ ...inputs, costByBranch });
  if (args.json) console.log(JSON.stringify(run, null, 2));
  else printRun(run);
}

function gh(ghArgs) {
  return execFileSync('gh', ghArgs, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function printRun(run) {
  console.log(`Run for #${run.issue.number} ${run.issue.title}${run.children.length ? ` (children ${run.children.map((n) => `#${n}`).join(', ')})` : ''}`);
  for (const row of run.rows) {
    const pr = row.pullRequest;
    console.log(`
#${row.issue} ${pr ? `PR ${pr.number} ${pr.state}, ${pr.branch} into ${pr.base ?? '?'}` : 'no pull request yet'}`);
    if (!pr) continue;
    console.log(`  start / end:  ${row.startedAt ?? NOT_RECORDED} .. ${row.endedAt ?? 'open'}`);
    console.log(`  coding:       ${showDuration(row.codingMs)}`);
    if (row.reviews === null) console.log(`  reviews:      ${NOT_RECORDED}`);
    else if (row.reviews.length === 0) console.log('  reviews:      none recorded');
    for (const r of row.reviews ?? []) {
      console.log(
        `  review:       ${r.kind} ${r.level ?? '?'} ${showDuration(r.ms)}, reported ${showCount(r.reported)}, fixed ${showCount(r.fixed)}, declined ${showCount(r.declined)}`,
      );
    }
    if (row.ci === null) console.log(`  ci:           ${NOT_RECORDED}`);
    else if (row.ci.length === 0) console.log('  ci:           none recorded');
    for (const wait of row.ci ?? []) console.log(`  ci wait:      ${showDuration(wait.ms)}, ${wait.outcome ?? NOT_RECORDED}`);
    console.log(`  cost:         ${showCost(row.figures.costUSD)}${row.unpricedTokens ? ` (+${row.unpricedTokens} unpriced tokens)` : ''}`);
  }
  const t = run.total;
  console.log(`
Total over ${run.rows.length} row(s)`);
  console.log(`  coding:       ${showTotal(t.codingMs, showDuration)}`);
  console.log(`  reviews:      ${showTotal(t.reviewMs, showDuration)}`);
  console.log(`  reported:     ${showTotal(t.reported, showCount)}`);
  console.log(`  fixed:        ${showTotal(t.fixed, showCount)}`);
  console.log(`  declined:     ${showTotal(t.declined, showCount)}`);
  console.log(`  ci:           ${showTotal(t.ciMs, showDuration)}`);
  console.log(`  cost:         ${showTotal(t.costUSD, showCost)}`);
}

/**
 * The issue a branch closes, through the pull request whose head it is - one
 * `gh` call for every pull request in the repository, read once up front
 * rather than per branch: hundreds of branches across a month of logs do not
 * carry `github-issue-<n>` themselves, and a call per branch is what made an
 * early version of this time out past two minutes on a single issue. Returns
 * the branch name itself for one no pull request names, or whose pull
 * request closes nothing - the fallback issue 421 asks for. Also keeps each pull request's session-record
 * marks by branch, read from the body the same call returns, for splitting an
 * issue's cost by phase.
 */
function makeIssueResolver(cwd) {
  const byBranch = new Map();
  let issuePrs = [];
  let bodyPrs = [];
  let marksUnreadable = false;
  try {
    issuePrs = listPullRequests(cwd, 'number,headRefName,closingIssuesReferences');
    for (const pr of issuePrs) {
      const issueNumber = pr.closingIssuesReferences?.[0]?.number;
      if (issueNumber && !byBranch.has(pr.headRefName)) byBranch.set(pr.headRefName, issueNumber);
    }
  } catch (error) {
    // No gh, no network, or gh failing - every branch not naming `github-issue-<n>` itself stands in as its own key.
    // Output that was cut off or unreadable is a loss the reader should hear about.
    if (error?.code === 'ENOBUFS' || error instanceof SyntaxError) {
      console.error(`warning: could not read the pull request list (${error.message}); pull requests are not resolved`);
    }
  }
  // A second call, for the bodies the session records are read from: its failure loses the split and nothing else.
  try {
    bodyPrs = listPullRequests(cwd, 'number,headRefName,body');
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      marksUnreadable = true;
      console.error(`warning: could not read the pull request bodies (${String(error?.message ?? error).split('\n')[0]}); phases are not split`);
    }
  }
  const marks = marksByBranch(issuePrs, bodyPrs);
  return {
    resolveIssue: (branch) => (branch ? (byBranch.get(branch) ?? branch) : null),
    resolveMarks: (branch) => (branch ? (marks.get(branch) ?? null) : null),
    marksUnreadable,
  };
}

/** Every pull request in the repository with the given fields, newest first; the buffer is large because bodies are long. */
function listPullRequests(cwd, fields) {
  const output = execFileSync('gh', ['pr', 'list', '--state', 'all', '--limit', '2000', '--json', fields], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(output);
}

function printTable(fullReport) {
  if (fullReport.issues.length === 0) {
    console.log('No attributed log lines in range.');
    return;
  }
  for (const issue of fullReport.issues) {
    console.log(`\nIssue ${issue.issue}${issue.branches.length ? ` (${issue.branches.join(', ')})` : ''}`);
    if (issue.wallClock) {
      console.log(`  wall-clock:   ${issue.wallClock.startedAt} .. ${issue.wallClock.endedAt}`);
    }
    console.log(`  active time:  ${formatDuration(issue.activeMs)}`);
    console.log(`  sessions:     ${issue.sessions}`);
    console.log(`  requests:     ${issue.requests.main} main, ${issue.requests.subagent} subagent`);
    console.log(
      `  subagents:    ${issue.subagents.total} total` +
        (issue.subagents.total ? ` (depth ${formatCounts(issue.subagents.byDepth)}; type ${formatCounts(issue.subagents.byType)})` : ''),
    );
    console.log(`  models:       ${formatCounts(issue.models.byRequests)} by request`);
    if (Object.keys(issue.models.byCost).length) {
      console.log(`                ${formatCounts(issue.models.byCost, (v) => `$${v.toFixed(4)}`)} by cost`);
    }
    console.log(
      `  tokens:       input ${issue.tokens.input}, cache read ${issue.tokens.cacheRead}, ` +
        `cache write 5m ${issue.tokens.cacheWrite5m}, cache write 1h ${issue.tokens.cacheWrite1h}, output ${issue.tokens.output}`,
    );
    console.log(
      `  cost:         $${issue.costUSD.total.toFixed(4)} ($${issue.costUSD.main.toFixed(4)} main, $${issue.costUSD.subagent.toFixed(4)} subagent)` +
        (issue.unpricedTokens ? `, plus ${issue.unpricedTokens} unpriced tokens (no rate for that model)` : ''),
    );
    if (issue.phases) {
      const shown = Object.entries(issue.phases).filter(([, p]) => p.costUSD > 0 || p.unpricedTokens > 0 || Object.values(p.tokens).some((n) => n > 0));
      console.log(`  by phase:     ${shown.map(([name, p]) => `${name} $${p.costUSD.toFixed(4)}${p.unpricedTokens ? ` (+${p.unpricedTokens} unpriced tokens)` : ''}`).join(', ')}`);
    } else {
      console.log(`  by phase:     unsplit (${issue.phasesNote})`);
    }
    if (issue.reviews.codeReview.length || issue.reviews.securityReview) {
      const codeReview = issue.reviews.codeReview.map((r) => `${r.level} x${r.count}`).join(', ') || 'none';
      console.log(`  code-review:  ${codeReview}`);
      console.log(`  security-review: ${issue.reviews.securityReview}`);
    }
    const findings = issue.findings;
    if (Object.keys(findings.byCategory).length || Object.keys(findings.byVerdict).length || Object.keys(findings.byOutcome).length) {
      console.log(`  findings:     by category ${formatCounts(findings.byCategory)}`);
      console.log(`                by verdict ${formatCounts(findings.byVerdict)}`);
      console.log(`                by outcome ${formatCounts(findings.byOutcome)}`);
    }
  }

  const totalRequests = fullReport.issues.reduce((sum, issue) => sum + issue.requests.main + issue.requests.subagent, 0);
  const totalSubagents = fullReport.issues.reduce((sum, issue) => sum + issue.subagents.total, 0);
  const totalCost = fullReport.issues.reduce((sum, issue) => sum + issue.costUSD.total, 0);
  console.log(`\n${fullReport.issues.length} issue(s), ${totalRequests} request(s), ${totalSubagents} subagent(s), $${totalCost.toFixed(2)} total`);
  if (fullReport.unpricedTokens) {
    console.log(`${fullReport.unpricedTokens} token(s) had no price in the table (a model not in issue 421's pricing table)`);
  }
}

function formatCounts(counts, formatValue = (v) => v) {
  const entries = Object.entries(counts);
  if (entries.length === 0) return 'none';
  return entries.map(([key, value]) => `${key}: ${formatValue(value)}`).join(', ');
}

function formatDuration(ms) {
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h${minutes}m` : `${minutes}m`;
}
