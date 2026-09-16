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
//
// Issue 421's own baseline: run over the month since 15 August 2026, this
// should land close to about 52,000 requests, 422 subagent transcripts and
// about $8,500 - the figures measured by hand before this existed.
//

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { readFlags } from './lib/operator.mjs';
import { buildReport, parseLine, projectDirsFor } from './lib/issue-cost.mjs';

let args;
try {
  args = readFlags(process.argv.slice(2), {
    takes: { '--since': 'since', '--issue': 'only' },
    switches: { '--json': 'json' },
  });
} catch (error) {
  console.error(`${error.message}

  pnpm cost:issue [--since <date>] [--issue <number>] [--json]`);
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
const allDirs = readdirSync(projectsDir).filter((name) => statSync(join(projectsDir, name)).isDirectory());
const projectDirs = projectDirsFor(repoRoot, allDirs)
  .map((name) => join(projectsDir, name))
  .filter((dir) => ownsDir(repoRoot, dir));

const report = buildReport({ projectDirs, resolveIssue: makeIssueResolver(repoRoot), since: sinceMs, only });

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printTable(report);
}

/**
 * Whether a candidate `~/.claude/projects/<dir>` really belongs to this repo,
 * checked against the one thing a lossy sanitized-path prefix match cannot
 * prove: a real `cwd` a session logged there. `projectDirsFor`'s prefix match
 * is a cheap first pass - it cannot tell a real worktree of this repo from an
 * unrelated sibling directory whose name happens to sanitize to the same
 * prefix plus a dash (`Cockpit-Backup` beside `Cockpit`, for one) - so this
 * reads one line of one session file the directory actually holds and checks
 * its `cwd` against `repoRoot` directly, which is unambiguous. A directory
 * with no readable session line is kept rather than dropped: silently losing
 * real data to an I/O hiccup is worse than the false positive this guards
 * against.
 */
function ownsDir(repoRoot, dir) {
  const jsonlName = readdirSync(dir).find((name) => name.endsWith('.jsonl') && statSync(join(dir, name)).isFile());
  if (!jsonlName) return true;
  let cwd;
  try {
    // Not necessarily the file's first line: an early `queue-operation` line carries no `cwd` at
    // all, so this reads until one line actually has one rather than trusting line 1 specifically.
    const lines = readFileSync(join(dir, jsonlName), 'utf8').split('\n', 20);
    cwd = lines.map(parseLine).find((line) => typeof line?.cwd === 'string' && line.cwd !== '')?.cwd;
  } catch {
    return true;
  }
  if (typeof cwd !== 'string' || cwd === '') return true;
  const normalize = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const root = normalize(repoRoot);
  const normalizedCwd = normalize(cwd);
  return normalizedCwd === root || normalizedCwd.startsWith(`${root}/`);
}

/**
 * The issue a branch closes, through the pull request whose head it is - one
 * `gh` call for every pull request in the repository, read once up front
 * rather than per branch: hundreds of branches across a month of logs do not
 * carry `github-issue-<n>` themselves, and a call per branch is what made an
 * early version of this time out past two minutes on a single issue. Returns
 * the branch name itself for one no pull request names, or whose pull
 * request closes nothing - the fallback issue 421 asks for.
 */
function makeIssueResolver(cwd) {
  const byBranch = new Map();
  try {
    const output = execFileSync(
      'gh',
      ['pr', 'list', '--state', 'all', '--limit', '2000', '--json', 'headRefName,closingIssuesReferences'],
      { cwd, encoding: 'utf8' },
    );
    for (const pr of JSON.parse(output)) {
      const issueNumber = pr.closingIssuesReferences?.[0]?.number;
      if (issueNumber && !byBranch.has(pr.headRefName)) byBranch.set(pr.headRefName, issueNumber);
    }
  } catch {
    // No gh, or no network - every branch not naming `github-issue-<n>` itself stands in as its own key.
  }
  return (branch) => (branch ? (byBranch.get(branch) ?? branch) : null);
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
