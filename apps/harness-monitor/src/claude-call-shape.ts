/**
 * The shape of a page of Cockpit's Claude calls, as production's route answers
 * it (`GET /v1/usage-records`). The Monitor imports nothing from Cockpit, so
 * this is its own copy of the shape Cockpit writes down in
 * `packages/shared/src/api/claude-calls-feed.ts`; a field added there is a
 * change here too. A page carrying anything else, a user included, is refused
 * whole and nothing from it is stored.
 */

/** One call as the Monitor stores it: the route's fields, the time in epoch milliseconds and the cost in millionths of a dollar. */
export interface ClaudeCall {
  id: number;
  occurredAt: number;
  environment: string;
  feature: string;
  promptVersion: string | null;
  startedBy: string | null;
  model: string;
  outcome: 'ok' | 'error' | 'timed-out';
  tokensIn: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  tokensOut: number | null;
  /** Production's cost, never the Monitor's; null where production has none. */
  costMicros: number | null;
  pullRequest: number | null;
  runId: number | null;
  branch: string | null;
}

export type CheckedPage = { ok: true; calls: ClaudeCall[]; more: boolean } | { ok: false; error: string };

const FIELDS = [
  'id', 'at', 'environment', 'feature', 'promptVersion', 'startedBy', 'model', 'outcome',
  'tokensIn', 'cacheRead', 'cacheWrite', 'tokensOut', 'costUsd', 'pullRequest', 'runId', 'branch',
] as const;
const OUTCOMES = ['ok', 'error', 'timed-out'] as const;
const TOKEN_FIELDS = ['tokensIn', 'cacheRead', 'cacheWrite', 'tokensOut'] as const;

/** A four-digit year and an explicit zone, so the day is never guessed. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const text = (value: unknown, max: number) => (typeof value === 'string' && value.trim() !== '' && value.length <= max ? value : null);

/** A string of at most `max`, or null; undefined when it is neither. */
function optionalText(value: unknown, max: number): string | null | undefined {
  if (value === null) return null;
  return text(value, max) ?? undefined;
}

const positive = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/**
 * Checks a page read after row `after`: exactly `{ calls, more }`, every call in
 * the route's shape with nothing added, numbered above `after` and rising. A
 * page saying there is more must carry a call to continue after.
 */
export function checkCallsPage(body: unknown, after: number): CheckedPage {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, error: 'the answer is not an object.' };
  const page = body as Record<string, unknown>;
  const extra = Object.keys(page).find((key) => key !== 'calls' && key !== 'more');
  if (extra) return { ok: false, error: `the answer carries "${extra}", which is not part of a page.` };
  if (!Array.isArray(page.calls)) return { ok: false, error: 'the answer has no list of calls.' };
  if (typeof page.more !== 'boolean') return { ok: false, error: 'the answer does not say whether there are more calls.' };
  if (page.more && page.calls.length === 0) return { ok: false, error: 'the answer says there are more calls but carries none to continue after.' };

  const calls: ClaudeCall[] = [];
  let last = after;
  for (const [index, raw] of page.calls.entries()) {
    const call = checkCall(raw);
    const id = (raw as { id?: unknown } | null)?.id;
    const named = `Call ${index}${positive(id) ? ` (row ${String(id)})` : ''}`;
    if (typeof call === 'string') return { ok: false, error: `${named} ${call}` };
    if (call.id <= last) return { ok: false, error: `${named} is not numbered after row ${last}.` };
    last = call.id;
    calls.push(call);
  }
  return { ok: true, calls, more: page.more };
}

/** The call, or what is wrong with it. */
function checkCall(raw: unknown): ClaudeCall | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'is not an object.';
  const r = raw as Record<string, unknown>;
  const extra = Object.keys(r).find((key) => !(FIELDS as readonly string[]).includes(key));
  if (extra) return `carries "${extra}", which a call does not have.`;

  if (!positive(r.id)) return 'has no row number.';
  if (typeof r.at !== 'string' || !ISO_TIME.test(r.at) || Number.isNaN(Date.parse(r.at))) return 'has no time, or one that is not an ISO 8601 timestamp with a time zone.';
  const environment = text(r.environment, 50);
  if (!environment) return 'has no environment.';
  const feature = text(r.feature, 200);
  if (!feature) return 'has no feature.';
  const model = text(r.model, 200);
  if (!model) return 'has no model.';
  if (!(OUTCOMES as readonly unknown[]).includes(r.outcome)) return `has outcome ${JSON.stringify(r.outcome)}, which is not one of ${OUTCOMES.join(', ')}.`;

  const promptVersion = optionalText(r.promptVersion, 100);
  if (promptVersion === undefined) return 'has a prompt version that is not a short string or null.';
  const startedBy = optionalText(r.startedBy, 100);
  if (startedBy === undefined) return 'has a started-by that is not a short string or null.';
  const branch = optionalText(r.branch, 300);
  if (branch === undefined) return 'has a branch that is not a short string or null.';

  const tokens: Record<string, number | null> = {};
  for (const field of TOKEN_FIELDS) {
    const value = r[field];
    if (value !== null && !(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) {
      return `has ${field} ${JSON.stringify(value)}, which is not a whole number of tokens, zero or more, or null.`;
    }
    tokens[field] = value;
  }
  if (r.costUsd !== null && !(typeof r.costUsd === 'number' && Number.isFinite(r.costUsd) && r.costUsd >= 0)) {
    return `has costUsd ${JSON.stringify(r.costUsd)}, which is not a number of dollars, zero or more, or null.`;
  }
  for (const field of ['pullRequest', 'runId'] as const) {
    if (r[field] !== null && !positive(r[field])) return `has ${field} ${JSON.stringify(r[field])}, which is not a positive whole number or null.`;
  }

  return {
    id: r.id as number,
    occurredAt: Date.parse(r.at),
    environment,
    feature,
    promptVersion,
    startedBy,
    model,
    outcome: r.outcome as ClaudeCall['outcome'],
    tokensIn: tokens.tokensIn!,
    cacheRead: tokens.cacheRead!,
    cacheWrite: tokens.cacheWrite!,
    tokensOut: tokens.tokensOut!,
    costMicros: r.costUsd === null ? null : Math.round((r.costUsd as number) * 1_000_000),
    pullRequest: r.pullRequest as number | null,
    runId: r.runId as number | null,
    branch,
  };
}
