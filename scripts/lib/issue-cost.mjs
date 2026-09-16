//
// What building each issue actually cost: time, requests, tokens, model mix
// and review passes, read from Claude Code's own session logs rather than
// measured by hand. Issue 421's "Blocked by" is none and its "Test cases" is
// "None, by decision" - the check that this counts correctly is the baseline
// run against a month of real logs, compared with the hand-measured figures
// that issue records, not a synthetic fixture. Nothing here is unit-tested
// for that reason; scripts/issue-cost.mjs is the CLI that runs it for real.
//
// **Attribution is per log line, not per session.** A session's `gitBranch`
// can change mid-session - one operator session built four issues back to
// back in the main checkout, switching branches between them - so every line
// carries its own branch and is credited to whichever issue that branch names
// at that moment, never to the session as a whole.
//
// **A request is one line, however many the log holds.** Claude Code writes
// one `assistant` line per content block (thinking, a tool call, the text),
// and every one of them repeats that request's full `usage` verbatim under
// the same `requestId` - confirmed against a real session file, where 49
// assistant lines carried only 23 distinct requests. Grouping by `requestId`
// and keeping one `usage` per group is what keeps a three-block reply from
// costing three times what it did.
//
// **Where the logs live**, on this machine: `~/.claude/projects/<dir>/`, one
// directory per distinct working directory Claude Code has run in, its name
// the path with every non-alphanumeric character turned into `-` (so
// `C:\GitHub\Cockpit` becomes `C--GitHub-Cockpit`, and a worktree under it
// keeps that as a prefix). A main session is `<dir>/<sessionId>.jsonl`; a
// subagent it spawned is `<dir>/<sessionId>/subagents/agent-<agentId>.jsonl` -
// a sibling directory named after the session, found by matching directory
// count against the issue's own stated baseline: 422 files, the same number
// named in "Blocked by: none" issue 421 itself.
//

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * List prices, dated, at list rates - copied verbatim from issue 421 rather
 * than re-derived, so a rate change is one diff against the issue that named
 * it. Per million tokens; cache multipliers apply to the input rate.
 */
export const PRICING = Object.freeze([
  { name: 'Opus 5', match: /^claude-opus-5(-|$)/, input: 5, output: 25, fastInput: 10, fastOutput: 50 },
  { name: 'Sonnet 5', match: /^claude-sonnet-5(-|$)/, input: 2, output: 10 },
  { name: 'Haiku 4.5', match: /^claude-haiku-4-5(-|$)/, input: 1, output: 5 },
]);

const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2;

/** A gap this long or longer is not counted as active time. */
const ACTIVE_GAP_MS = 30 * 60 * 1000;

/** Every character `~/.claude/projects/<name>` can hold in place of a path separator. */
export function sanitizePath(path) {
  return String(path ?? '').replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * The project directories, among `allDirs`, that belong to this repository -
 * its main checkout and every worktree under it, present or long since
 * removed (a worktree's logs outlive the worktree itself). Matched by prefix
 * against the sanitized repo root rather than against `git worktree list`,
 * which only knows about worktrees that still exist.
 *
 * The trailing-`-` check is what stops `Cockpit2` matching a repo root ending
 * in `Cockpit`: sanitizing turns the path separator after the root into `-`,
 * so a real child always has that boundary and a same-prefixed sibling never
 * does.
 */
export function projectDirsFor(repoRoot, allDirs) {
  const prefix = sanitizePath(repoRoot);
  return (allDirs ?? []).filter((name) => name === prefix || name.startsWith(`${prefix}-`));
}

/** One line of a session log, or `null` for a line that failed to parse. */
export function parseLine(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** `github-issue-<n>` in a branch name, Cockpit's own convention for a branch built from an issue. */
const ISSUE_BRANCH = /github-issue-(\d+)/;

/** The issue a branch names directly, or `null` where it has to be resolved through a pull request instead. */
export function issueFromBranchName(branch) {
  const found = ISSUE_BRANCH.exec(String(branch ?? ''));
  return found ? Number(found[1]) : null;
}

/** `value` as a finite number, or 0 - a non-numeric field in a hand-edited or corrupted log line becomes a gap in the totals, never a `NaN` that silently poisons every sum it touches. */
function numberOr0(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** The tokens in one request's `usage`, by the kind this report breaks them into. */
export function tokensOf(usage) {
  const cacheCreation = usage?.cache_creation ?? {};
  return {
    input: numberOr0(usage?.input_tokens),
    cacheRead: numberOr0(usage?.cache_read_input_tokens),
    cacheWrite5m: numberOr0(cacheCreation.ephemeral_5m_input_tokens),
    cacheWrite1h: numberOr0(cacheCreation.ephemeral_1h_input_tokens),
    output: numberOr0(usage?.output_tokens),
  };
}

/**
 * The cost of one request's `usage`, in dollars, or `null` for a model this
 * table has no price for (Fable, at the time this was written) - counted in
 * `unpricedTokens` instead of silently priced at zero.
 */
export function costOf(usage, model, speed) {
  const pricing = PRICING.find((row) => row.match.test(String(model ?? '')));
  if (!pricing) return null;
  const fast = speed === 'fast' && pricing.fastInput != null;
  const inputRate = fast ? pricing.fastInput : pricing.input;
  const outputRate = fast ? pricing.fastOutput : pricing.output;
  const t = tokensOf(usage);
  const perMillion = (tokens, rate) => (tokens / 1_000_000) * rate;

  return (
    perMillion(t.input, inputRate) +
    perMillion(t.cacheRead, inputRate * CACHE_READ_MULTIPLIER) +
    perMillion(t.cacheWrite5m, inputRate * CACHE_WRITE_5M_MULTIPLIER) +
    perMillion(t.cacheWrite1h, inputRate * CACHE_WRITE_1H_MULTIPLIER) +
    perMillion(t.output, outputRate)
  );
}

/**
 * Milliseconds of active time in a sorted list of timestamps (ms since
 * epoch): consecutive gaps of `ACTIVE_GAP_MS` or more are left out, per issue
 * 421's "active time with gaps over 30 minutes left out".
 */
export function activeMillis(sortedTimestampsMs) {
  let total = 0;
  for (let i = 1; i < sortedTimestampsMs.length; i += 1) {
    const gap = sortedTimestampsMs[i] - sortedTimestampsMs[i - 1];
    if (gap > 0 && gap < ACTIVE_GAP_MS) total += gap;
  }
  return total;
}

/** A fresh, empty per-issue accumulator - one is created the first time an issue's key is seen. */
function emptyIssueStats(key) {
  return {
    issue: key,
    branches: new Set(),
    sessions: new Set(),
    timestampsMs: [],
    requests: { main: new Map(), subagent: new Map() }, // requestId -> { model, speed, usage }
    subagents: new Map(), // agentId -> { depth, type }
    reviews: { codeReview: new Map(), securityReview: 0 }, // level -> count
    findings: { byCategory: new Map(), byVerdict: new Map(), byOutcome: new Map() },
  };
}

function bump(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/**
 * A subagent's own depth and type, from the sidecar Claude Code already
 * writes next to its transcript - `agent-<agentId>.meta.json`, holding
 * `{ agentType, spawnDepth, parentAgentId, ... }` - rather than reconstructed
 * by regex-matching an `agentId:` mention out of another transcript's
 * free-text tool result. Confirmed against every one of 434 subagent
 * transcripts on this machine: each has a matching `.meta.json`, including a
 * real `spawnDepth: 2` case for a subagent that itself spawned one. Falls
 * back to depth 1 / `unknown` for a transcript from a Claude Code version old
 * enough not to have written the sidecar.
 */
function subagentMeta(jsonlPath) {
  try {
    const meta = JSON.parse(readFileSync(jsonlPath.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
    const depth = Number(meta.spawnDepth);
    return { depth: Number.isInteger(depth) && depth > 0 ? depth : 1, type: meta.agentType || 'unknown' };
  } catch {
    return { depth: 1, type: 'unknown' };
  }
}

/** The `/code-review` and `/security-review` runs one line holds - the Skill tool, self-invoked per CLAUDE.md rather than typed by a person. */
function reviewSkillCallsOnLine(line) {
  const calls = [];
  if (line?.type !== 'assistant' || !Array.isArray(line.message?.content)) return calls;
  for (const block of line.message.content) {
    if (block?.type !== 'tool_use' || block.name !== 'Skill') continue;
    const skill = block.input?.skill;
    if (skill === 'code-review' || skill === 'security-review') {
      calls.push({ skill, level: skill === 'code-review' ? block.input?.args ?? null : null });
    }
  }
  return calls;
}

/**
 * Every `ReportFindings` call in a transcript, one finding list per call, with
 * the index of the line it appeared on (so a caller can still attribute it to
 * that line's branch).
 */
function reportFindingsCalls(lines) {
  const calls = [];
  lines.forEach((line, lineIndex) => {
    if (line?.type !== 'assistant' || !Array.isArray(line.message?.content)) return;
    for (const block of line.message.content) {
      if (block?.type === 'tool_use' && block.name === 'ReportFindings' && Array.isArray(block.input?.findings)) {
        calls.push({ lineIndex, findings: block.input.findings });
      }
    }
  });
  return calls;
}

/**
 * What identifies a finding across the two `ReportFindings` calls of one
 * review pass: `file` and `line` alone, not `summary` too. Confirmed against
 * a real pair of calls where both stayed put but the wording didn't - one
 * summary's own count ("16 live model calls to 25 per nightly run") changed
 * to 26 once a later fix added a case, and another was quietly reworded from
 * present to past tense between the initial report and the re-report of the
 * same finding. `file`+`line` had no such drift across either pair.
 */
function findingIdentity(finding) {
  return JSON.stringify([finding?.file ?? '', finding?.line ?? '']);
}

/** Whether every finding in `a` matches the finding at the same position in `b`, so `b` reads as a re-report of exactly `a` rather than a same-sized coincidence. */
function sameReview(a, b) {
  return a.length === b.length && a.every((finding, i) => findingIdentity(finding) === findingIdentity(b[i]));
}

/**
 * The findings a transcript actually carries, keyed by the line each surviving
 * call appeared on, once a re-report has been folded into the call it
 * re-reports - never both, which double-counted every category and verdict
 * the first time this ran against a real session (issue 391's own findings
 * came back at 16 instead of the 8 its pull request records). ReportFindings'
 * own contract: call once with the verified list, then call again with the
 * same findings and `outcome` added once fixes land. Findings carry no stable
 * id, so a later call is read as that re-report only when every finding in it
 * matches the earlier call's one-for-one (`sameReview`) - a same-*length*
 * coincidence between two unrelated reviews is not enough, which an earlier
 * length-only version of this got wrong.
 *
 * `keyFor(lineIndex)` is the issue each call's own line resolves to: matching
 * only runs within one key's own calls, because a transcript can span more
 * than one issue (this file's own top comment) and an unrelated review for a
 * *different* issue must never supersede this one's.
 */
function dedupedFindings(lines, keyFor) {
  const byKey = new Map();
  for (const call of reportFindingsCalls(lines)) {
    const key = keyFor(call.lineIndex);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(call);
  }

  const result = [];
  for (const calls of byKey.values()) {
    const superseded = new Set();
    for (let i = 0; i < calls.length; i += 1) {
      if (calls[i].findings.some((f) => f.outcome)) continue;
      if (calls.slice(i + 1).some((later) => sameReview(calls[i].findings, later.findings))) superseded.add(calls[i]);
    }
    result.push(...calls.filter((call) => !superseded.has(call)));
  }
  return result;
}

/**
 * Every line of one transcript file (main session or subagent), tagged with
 * the branch in force at that line - carried forward from the last line that
 * named one, since not every line type repeats it (an early `queue-operation`
 * line, before the first turn, never does).
 */
function readTranscript(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const lines = [];
  let branch = null;
  for (const raw of text.split('\n')) {
    if (raw === '') continue;
    const line = parseLine(raw);
    if (line === null) continue;
    if (typeof line.gitBranch === 'string' && line.gitBranch !== '') branch = line.gitBranch;
    lines.push({ ...line, resolvedBranch: branch });
  }
  return lines;
}

/**
 * Every `agent-*.jsonl` file under a session's `subagents/` directory - flat,
 * however deep the agent that spawned it actually nests (`subagentMeta`'s own
 * comment has the confirmation), so no recursive directory walk is needed.
 */
function subagentFilesUnder(dir) {
  const subagentsDir = join(dir, 'subagents');
  if (!existsSync(subagentsDir)) return [];
  return readdirSync(subagentsDir)
    .filter((entry) => entry.startsWith('agent-') && entry.endsWith('.jsonl'))
    .map((entry) => ({ path: join(subagentsDir, entry), agentId: entry.slice('agent-'.length, -'.jsonl'.length) }));
}

/**
 * Every main session `.jsonl` file directly under a project directory - never
 * the `memory/` folder or a `.desktop-released.json`/extension-less sidecar
 * Claude Code also leaves there, which a plain `*.jsonl` glob would not
 * exclude on its own.
 */
function mainSessionFilesIn(projectDir) {
  return readdirSync(projectDir)
    .filter((name) => name.endsWith('.jsonl') && statSync(join(projectDir, name)).isFile())
    .map((name) => ({ path: join(projectDir, name), sessionId: name.slice(0, -'.jsonl'.length) }));
}

/**
 * The whole report: every issue with at least one attributed line, in the
 * project directories given. `resolveIssue(branch)` answers the fallback the
 * issue's own body asks for - the pull request whose head is that branch and
 * the issue it closes - for a branch `issueFromBranchName` cannot place
 * itself; it may return a number, a string (the branch standing in for
 * itself), or `null`/undefined to mean "still couldn't place it", which also
 * falls back to the branch name. It is a function rather than a lookup table
 * because resolving it costs a `gh` call the caller may want to cache or
 * skip.
 *
 * `since`, if given, is milliseconds since epoch: lines timestamped earlier
 * are left out entirely, from both the wall-clock span and every count.
 */
export function buildReport({ projectDirs, resolveIssue, since = null, only = null }) {
  const perIssue = new Map();

  function issueStats(key) {
    if (!perIssue.has(key)) perIssue.set(key, emptyIssueStats(key));
    return perIssue.get(key);
  }

  function keyFor(branch) {
    const direct = issueFromBranchName(branch);
    if (direct !== null) return direct;
    const resolved = resolveIssue?.(branch);
    return resolved ?? branch ?? '(no branch)';
  }

  for (const projectDir of projectDirs) {
    for (const { path, sessionId } of mainSessionFilesIn(projectDir)) {
      attribute(readTranscript(path), { sessionId, isSubagent: false });
      for (const sub of subagentFilesUnder(join(projectDir, sessionId))) {
        const info = subagentMeta(sub.path);
        attribute(readTranscript(sub.path), { sessionId, isSubagent: true, agentId: sub.agentId, depth: info.depth, subagentType: info.type });
      }
    }
  }

  function attribute(lines, { sessionId, isSubagent, agentId, depth, subagentType }) {
    // Per issue key, not per file: a file's lines can resolve to more than one issue (this
    // module's own top comment), so a request or a subagent seen once under key A must still be
    // recorded again the first time key B's own lines reach it - collapsing both into one file-wide
    // tracker silently dropped everything but the first key a file happened to touch.
    const seenRequestIdsByKey = new Map();
    const findingsByLineIndex = new Map();
    for (const call of dedupedFindings(lines, (lineIndex) => keyFor(lines[lineIndex].resolvedBranch))) {
      findingsByLineIndex.set(call.lineIndex, [...(findingsByLineIndex.get(call.lineIndex) ?? []), ...call.findings]);
    }

    for (const [lineIndex, line] of lines.entries()) {
      const key = keyFor(line.resolvedBranch);
      if (only !== null && String(key) !== String(only)) continue;
      const timestampMs = Date.parse(line.timestamp ?? '');
      if (Number.isNaN(timestampMs)) continue;
      if (since !== null && timestampMs < since) continue;

      const stats = issueStats(key);
      if (line.resolvedBranch) stats.branches.add(line.resolvedBranch);
      stats.timestampsMs.push(timestampMs);
      if (!isSubagent) stats.sessions.add(sessionId);
      if (isSubagent) stats.subagents.set(agentId, { depth, type: subagentType });

      if (line.type === 'assistant' && line.requestId) {
        if (!seenRequestIdsByKey.has(key)) seenRequestIdsByKey.set(key, new Set());
        const seenRequestIds = seenRequestIdsByKey.get(key);
        if (!seenRequestIds.has(line.requestId)) {
          seenRequestIds.add(line.requestId);
          const bucket = isSubagent ? stats.requests.subagent : stats.requests.main;
          bucket.set(line.requestId, { model: line.message?.model, speed: line.message?.usage?.speed, usage: line.message?.usage });
        }
      }

      // `/code-review` runs inline, so its Skill call lives in the main session; `/security-review`
      // runs as its own Agent subagent per CLAUDE.md, so its Skill call lives in the subagent's
      // transcript instead - both are counted the same way, wherever the line came from.
      for (const call of reviewSkillCallsOnLine(line)) {
        if (call.skill === 'code-review') bump(stats.reviews.codeReview, call.level ?? '(no level)');
        else stats.reviews.securityReview += 1;
      }

      for (const finding of findingsByLineIndex.get(lineIndex) ?? []) {
        if (finding.category) bump(stats.findings.byCategory, finding.category);
        if (finding.verdict) bump(stats.findings.byVerdict, finding.verdict);
        if (finding.outcome) bump(stats.findings.byOutcome, finding.outcome);
      }
    }
  }

  const issues = [...perIssue.values()].map(summarize).sort(sortByIssue);
  return { issues, unpricedTokens: issues.reduce((total, issue) => total + issue.unpricedTokens, 0) };
}

function sortByIssue(a, b) {
  const an = typeof a.issue === 'number' ? a.issue : Infinity;
  const bn = typeof b.issue === 'number' ? b.issue : Infinity;
  if (an !== bn) return an - bn;
  return String(a.issue).localeCompare(String(b.issue));
}

/** Turns one issue's raw accumulator into the shape a caller (the CLI table, or JSON) reads. */
function summarize(stats) {
  const timestamps = [...stats.timestampsMs].sort((a, b) => a - b);

  const tokens = { input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 };
  const modelsByRequests = new Map();
  const modelsByCost = new Map();
  let costMain = 0;
  let costSubagent = 0;
  let unpricedTokens = 0;

  function fold(entries, isSubagent) {
    for (const { model, speed, usage } of entries) {
      const t = tokensOf(usage);
      tokens.input += t.input;
      tokens.cacheRead += t.cacheRead;
      tokens.cacheWrite5m += t.cacheWrite5m;
      tokens.cacheWrite1h += t.cacheWrite1h;
      tokens.output += t.output;

      bump(modelsByRequests, model ?? '(unknown model)');

      const cost = costOf(usage, model, speed);
      if (cost === null) {
        unpricedTokens += t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h + t.output;
      } else {
        modelsByCost.set(model, (modelsByCost.get(model) ?? 0) + cost);
        if (isSubagent) costSubagent += cost;
        else costMain += cost;
      }
    }
  }
  fold(stats.requests.main.values(), false);
  fold(stats.requests.subagent.values(), true);

  const byDepth = new Map();
  const byType = new Map();
  for (const { depth, type } of stats.subagents.values()) {
    bump(byDepth, depth);
    bump(byType, type);
  }

  // Rounded first, so `total` is their rounded sum rather than a third rounding of the raw total -
  // the two halves a reader sees always add up to the total printed beside them.
  const mainCost = round(costMain);
  const subagentCost = round(costSubagent);

  return {
    issue: stats.issue,
    branches: [...stats.branches].sort(),
    wallClock:
      timestamps.length === 0
        ? null
        : { startedAt: new Date(timestamps[0]).toISOString(), endedAt: new Date(timestamps[timestamps.length - 1]).toISOString() },
    activeMs: activeMillis(timestamps),
    sessions: stats.sessions.size,
    requests: { main: stats.requests.main.size, subagent: stats.requests.subagent.size },
    subagents: { total: stats.subagents.size, byDepth: mapToObject(byDepth), byType: mapToObject(byType) },
    models: { byRequests: mapToObject(modelsByRequests), byCost: mapToObject(modelsByCost, (v) => round(v)) },
    tokens,
    costUSD: { total: round(mainCost + subagentCost), main: mainCost, subagent: subagentCost },
    unpricedTokens,
    reviews: {
      codeReview: [...stats.reviews.codeReview].map(([level, count]) => ({ level, count })).sort((a, b) => a.level.localeCompare(b.level)),
      securityReview: stats.reviews.securityReview,
    },
    findings: {
      byCategory: mapToObject(stats.findings.byCategory),
      byVerdict: mapToObject(stats.findings.byVerdict),
      byOutcome: mapToObject(stats.findings.byOutcome),
    },
  };
}

function round(dollars) {
  return Math.round(dollars * 10000) / 10000;
}

function mapToObject(map, transform = (v) => v) {
  return Object.fromEntries([...map].map(([k, v]) => [String(k), transform(v)]));
}
