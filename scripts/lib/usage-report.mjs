//
// What a Claude Code session spent, as the rows the Harness Monitor stores
// ("Report each Claude Code session's usage to the Harness Monitor from a
// hook, with its category", issue 972). Pure: log lines, phase marks and the
// environment in, rows out; `scripts/report-usage.mjs` is the I/O around it.
//
// **A row carries ids, times, branch, category, model and counts, never text
// from the conversation.** `toRow` copies named fields rather than passing a
// log line through, so a field added to the log later cannot leak.
//
// **A request is one row however many log lines it spans**, keyed by the
// request id Claude Code writes on each, so a resumed or forked session that
// repeats earlier lines yields the same ids and the monitor keeps one.
//

import { reviewSkillCallsOnLine } from './issue-cost.mjs';
import { REVIEW_LEVELS } from './session-record.mjs';

/** The most rows the monitor takes in one write (`MAX_BATCH` in its validator). */
export const MAX_BATCH = 200;


/** The log's lines as parsed objects, and how many non-blank lines were not JSON objects. */
export function readLog(text) {
  const lines = [];
  let unreadable = 0;
  for (const raw of String(text ?? '').split('\n')) {
    if (raw.trim() === '') continue;
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      // A half-written or corrupted line costs that line only.
    }
    if (line !== null && typeof line === 'object') lines.push(line);
    else unreadable += 1;
  }
  return { lines, unreadable };
}

/** The log's lines as parsed objects, skipping any that is not JSON. */
export function parseLog(text) {
  return readLog(text).lines;
}

/**
 * Whether a subagent's log runs `/security-review`: it calls the Skill tool
 * with that skill, as `cost:issue` counts it. A prompt that merely mentions
 * the review (a build brief saying it is done elsewhere) does not qualify.
 */
const runsSecurityReview = (lines) => lines.some((line) => reviewSkillCallsOnLine(line).some((call) => call.skill === 'security-review'));

const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);

/**
 * The requests one log holds, in order, one per request id. `subagent` says
 * the log is a subagent's. Lines with no request id, model or time are not
 * requests; the first line of a request supplies its figures, as in `cost:issue`.
 */
export function requestsFromLog(lines, { sessionId, subagent }) {
  const securityReview = subagent && runsSecurityReview(lines);
  const seen = new Set();
  const requests = [];
  for (const line of lines) {
    if (line.type !== 'assistant' || !line.requestId) continue;
    if (seen.has(line.requestId)) continue;
    const model = line.message?.model;
    const usage = line.message?.usage;
    const at = Date.parse(line.timestamp ?? '');
    if (typeof model !== 'string' || model === '' || model.startsWith('<') || !usage || Number.isNaN(at)) continue;
    seen.add(line.requestId);
    requests.push({
      requestId: line.requestId,
      sessionId,
      at,
      branch: typeof line.gitBranch === 'string' && line.gitBranch !== '' ? line.gitBranch : null,
      model,
      speed: usage.speed === 'fast' ? 'fast' : 'standard',
      inputTokens: count(usage.input_tokens),
      outputTokens: count(usage.output_tokens),
      cacheCreationTokens: count(usage.cache_creation_input_tokens),
      cacheReadTokens: count(usage.cache_read_input_tokens),
      subagent,
      securityReview,
    });
  }
  return requests;
}

/** Where a session is running, from its environment: Actions, a cloud session, or a machine of ours. */
export function whereItRan(env) {
  if (env.GITHUB_ACTIONS === 'true') return 'actions';
  if (env.CLAUDE_CODE_REMOTE === 'true') return 'cloud';
  return 'local';
}

/**
 * The review windows and milestones of one branch's marks, for placing a
 * moment. A window closes at the matching `review-end` of its kind, else at
 * the next mark that is not a review mark, else it stays open.
 */
function readMarks(entries) {
  const marks = entries
    .map(({ at, phase, kind, level }) => ({ ms: Date.parse(at), phase, kind, level }))
    .filter((mark) => !Number.isNaN(mark.ms))
    .sort((a, b) => a.ms - b.ms);
  const first = (phase) => marks.find((mark) => mark.phase === phase)?.ms ?? null;
  const windows = [];
  marks.forEach((mark, i) => {
    if (mark.phase !== 'review-start') return;
    const later = marks.slice(i + 1);
    const closing = later.find((m) => (m.phase === 'review-end' && m.kind === mark.kind) || (m.phase !== 'review-start' && m.phase !== 'review-end'));
    windows.push({ from: mark.ms, to: closing?.ms ?? Infinity, kind: mark.kind, level: mark.level });
  });
  return { any: marks.length > 0, scoped: first('scoped'), pushed: first('pushed'), windows };
}

/**
 * The category a request was made in, and its review level where it is a code
 * review. Actions decide first, whatever the marks say; then the security
 * review subagent; then the branch's marks at the request's own time. A
 * request after `pushed` is after push even inside a review window, so a
 * recheck of a pushed branch is the cost of having pushed.
 *
 * `marksOf(branch)` gives that branch's record entries, so a session that
 * switched branches places each request by its own branch's marks.
 */
export function categoryOf(request, { ranWhere, marksOf }) {
  if (ranWhere === 'actions') return { category: 'ci-reviews' };
  if (request.securityReview) return { category: 'local-security-review' };
  if (request.branch === 'main') return { category: 'scoping-planning' };
  const marks = readMarks(request.branch === null ? [] : marksOf(request.branch));
  if (!marks.any) return { category: 'building' };
  if (marks.pushed !== null && marks.pushed <= request.at) return { category: 'after-push' };
  const window = marks.windows.find((w) => w.from <= request.at && request.at < w.to);
  if (window?.kind === 'security-review') return { category: 'local-security-review' };
  if (window?.kind === 'code-review') {
    return { category: 'local-code-review', ...(REVIEW_LEVELS.includes(window.level) ? { reviewLevel: window.level } : {}) };
  }
  if (marks.scoped === null || request.at < marks.scoped) return { category: 'scoping-planning' };
  return { category: 'building' };
}

/** One request as the monitor's write takes it. Named fields only: nothing else of the log crosses. */
export function toRow(request, { ranWhere, marksOf, source = 'hook' }) {
  const { category, reviewLevel } = categoryOf(request, { ranWhere, marksOf });
  return {
    requestId: request.requestId,
    sessionId: request.sessionId,
    time: new Date(request.at).toISOString(),
    branch: request.branch,
    category,
    ...(reviewLevel ? { reviewLevel } : {}),
    model: request.model,
    speed: request.speed,
    inputTokens: request.inputTokens,
    outputTokens: request.outputTokens,
    cacheCreationTokens: request.cacheCreationTokens,
    cacheReadTokens: request.cacheReadTokens,
    subagent: request.subagent,
    ranWhere,
    source,
  };
}

/** Every request across the main log and the subagent logs, once by request id. */
export function allRequests(logs) {
  const byId = new Map();
  for (const { lines, sessionId, subagent } of logs) {
    for (const request of requestsFromLog(lines, { sessionId, subagent })) {
      if (!byId.has(request.requestId)) byId.set(request.requestId, request);
    }
  }
  return [...byId.values()];
}

/**
 * Sends the rows not yet sent, in batches the monitor takes, and says which
 * ids now count as sent. Does nothing without a key. A send that fails or
 * times out ends the run quietly with the earlier batches kept, so the rest
 * go again next turn alongside the new rows.
 *
 * `post(rows)` resolves true when the monitor stored the batch, `'rejected'`
 * when it refused the rows as invalid (retrying cannot help), anything else
 * for a failure worth retrying. The monitor refuses a whole batch for one bad
 * row, so a rejected batch is re-sent row by row and the rows still rejected
 * count as sent: one unfixable row must not hold back every later one.
 */
export async function sendUnsent({ key, rows, sentIds, post }) {
  const sent = new Set(sentIds);
  if (!key) return { sent };
  const attempt = async (batch) => {
    try {
      return await post(batch);
    } catch {
      return false;
    }
  };
  const waiting = rows.filter((row) => !sent.has(row.requestId));
  for (let i = 0; i < waiting.length; i += MAX_BATCH) {
    const batch = waiting.slice(i, i + MAX_BATCH);
    const outcome = await attempt(batch);
    if (outcome === true) {
      for (const row of batch) sent.add(row.requestId);
    } else if (outcome === 'rejected') {
      for (const row of batch) {
        const single = await attempt([row]);
        if (single !== true && single !== 'rejected') return { sent };
        sent.add(row.requestId);
      }
    } else {
      break;
    }
  }
  return { sent };
}
