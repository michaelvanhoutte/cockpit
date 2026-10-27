/**
 * CI stability's runs as the Stability job sends them (tools/ci-stability):
 * each run on `main` with its jobs and their steps, already counted by the tool.
 * The Monitor checks their shape and stores them; it derives nothing, so a
 * shard family arrives as one job and each outcome arrives decided.
 */

/** What a run or job counts as, decided by the tool. Only `pass` and `fail` count towards a duration. */
export const OUTCOMES = ['pass', 'fail', 'cancelled', 'skipped', 'running', 'other', 'unknown'] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** Most runs one send may carry. The body is capped too, at the Worker's MAX_BODY characters. */
export const MAX_RUNS = 50;
/** Most jobs in one run, and steps in one job: far above any workflow here, so only a malformed send reaches them. */
export const MAX_JOBS = 200;
export const MAX_STEPS = 300;

export interface StabilityStep {
  position: number;
  number: number | null;
  name: string;
  occurrence: number;
  conclusion: string | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
}

export interface StabilityJob {
  jobIndex: number;
  name: string;
  status: string;
  conclusion: string | null;
  outcome: Outcome;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  failedStep: string | null;
  url: string | null;
  steps: StabilityStep[];
}

export interface StabilityRun {
  id: number;
  workflow: string;
  path: string;
  status: string;
  conclusion: string | null;
  outcome: Outcome;
  headSha: string;
  createdAt: number;
  url: string;
  jobs: StabilityJob[];
}

export type CheckedRuns = { ok: true; runs: StabilityRun[] } | { ok: false; error: string };

/** A four-digit year and an explicit zone, as GitHub writes every time. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
export const SHA = /^[0-9a-f]{7,64}$/;

export type Fields = Record<string, unknown>;

export const isObject = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value);

export function text(value: unknown, max: number, { empty = false } = {}): string | null {
  return typeof value === 'string' && (empty || value.trim() !== '') && value.length <= max ? value : null;
}

/** A time GitHub wrote, as epoch milliseconds; null when absent; undefined when it is not a time. */
export function time(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !ISO_TIME.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

export function wholeOrNull(value: unknown, min: number): number | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min ? value : undefined;
}

/**
 * A conclusion is always sent: a string once the run or job completed, null
 * while it has not. A completed one with none, or a missing key, is refused.
 */
export function conclusionOf(r: Fields, status: string): string | null | { error: string } {
  if (r.conclusion === undefined) return { error: 'has no conclusion.' };
  if (r.conclusion === null) return status === 'completed' ? { error: 'has no conclusion, though it completed.' } : null;
  return text(r.conclusion, 50) ?? { error: `has conclusion ${JSON.stringify(r.conclusion)}, which is not a short string.` };
}

export function outcomeOf(value: unknown): Outcome | null {
  return typeof value === 'string' && (OUTCOMES as readonly string[]).includes(value) ? (value as Outcome) : null;
}

const durationError = (value: unknown) => `has durationMs ${JSON.stringify(value)}, which is not a whole number of milliseconds, zero or more.`;

function checkStep(raw: unknown, position: number): StabilityStep | string {
  if (!isObject(raw)) return 'is not an object.';
  const name = text(raw.name, 300, { empty: true });
  if (name === null) return 'has no name.';
  const occurrence = wholeOrNull(raw.occurrence, 1);
  if (occurrence === null || occurrence === undefined) return `has occurrence ${JSON.stringify(raw.occurrence)}, which is not a whole number, one or more.`;
  const number = wholeOrNull(raw.number, 0);
  if (number === undefined) return `has number ${JSON.stringify(raw.number)}, which is not a whole number.`;
  let conclusion: string | null = null;
  if (raw.conclusion !== null && raw.conclusion !== undefined) {
    conclusion = text(raw.conclusion, 50);
    if (conclusion === null) return `has conclusion ${JSON.stringify(raw.conclusion)}, which is not a short string.`;
  }
  const startedAt = time(raw.startedAt);
  if (startedAt === undefined) return 'has a startedAt that is not an ISO 8601 timestamp with a time zone.';
  const completedAt = time(raw.completedAt);
  if (completedAt === undefined) return 'has a completedAt that is not an ISO 8601 timestamp with a time zone.';
  const durationMs = wholeOrNull(raw.durationMs, 0);
  if (durationMs === undefined) return durationError(raw.durationMs);
  return { position, number, name, occurrence, conclusion, startedAt, completedAt, durationMs };
}

export function checkJob(raw: unknown, jobIndex: number): StabilityJob | string {
  if (!isObject(raw)) return 'is not an object.';
  const name = text(raw.name, 300);
  if (!name) return 'has no name.';
  const status = text(raw.status, 50);
  if (!status) return 'has no status.';
  const conclusion = conclusionOf(raw, status);
  if (conclusion !== null && typeof conclusion === 'object') return conclusion.error;
  const outcome = outcomeOf(raw.outcome);
  if (!outcome) return `has outcome ${JSON.stringify(raw.outcome)}, which is not one of ${OUTCOMES.join(', ')}.`;
  const startedAt = time(raw.startedAt);
  if (startedAt === undefined) return 'has a startedAt that is not an ISO 8601 timestamp with a time zone.';
  const completedAt = time(raw.completedAt);
  if (completedAt === undefined) return 'has a completedAt that is not an ISO 8601 timestamp with a time zone.';
  const durationMs = wholeOrNull(raw.durationMs, 0);
  if (durationMs === undefined) return durationError(raw.durationMs);
  let failedStep: string | null = null;
  if (raw.failedStep !== null && raw.failedStep !== undefined) {
    failedStep = text(raw.failedStep, 300, { empty: true });
    if (failedStep === null) return 'has a failedStep that is not a short string.';
  }
  let url: string | null = null;
  if (raw.url !== null && raw.url !== undefined) {
    url = text(raw.url, 500);
    if (!url?.startsWith('https://')) return 'has a url that is not an https address.';
  }
  if (!Array.isArray(raw.steps)) return 'has no list of steps.';
  if (raw.steps.length > MAX_STEPS) return `has ${raw.steps.length} steps; the most one job takes is ${MAX_STEPS}.`;
  const steps: StabilityStep[] = [];
  for (const [position, rawStep] of raw.steps.entries()) {
    const step = checkStep(rawStep, position);
    if (typeof step === 'string') {
      const stepName = isObject(rawStep) ? text(rawStep.name, 300) : null;
      return `step ${position}${stepName ? ` (${stepName})` : ''} ${step}`;
    }
    steps.push(step);
  }
  return { jobIndex, name, status, conclusion, outcome, startedAt, completedAt, durationMs, failedStep, url, steps };
}

function checkRun(raw: unknown): StabilityRun | string {
  if (!isObject(raw)) return 'is not an object.';
  const id = wholeOrNull(raw.id, 1);
  if (id === null || id === undefined) return 'has no id.';
  const workflow = text(raw.workflow, 300);
  if (!workflow) return 'has no workflow.';
  const path = text(raw.path, 300);
  if (!path) return 'has no path.';
  const status = text(raw.status, 50);
  if (!status) return 'has no status.';
  const conclusion = conclusionOf(raw, status);
  if (conclusion !== null && typeof conclusion === 'object') return conclusion.error;
  const outcome = outcomeOf(raw.outcome);
  if (!outcome) return `has outcome ${JSON.stringify(raw.outcome)}, which is not one of ${OUTCOMES.join(', ')}.`;
  if (typeof raw.headSha !== 'string' || !SHA.test(raw.headSha)) return 'has a headSha that is not a commit hash.';
  const createdAt = time(raw.createdAt);
  if (createdAt === null || createdAt === undefined) return 'has a createdAt that is not an ISO 8601 timestamp with a time zone.';
  const url = text(raw.url, 500);
  if (!url?.startsWith('https://')) return 'has a url that is not an https address.';
  if (!Array.isArray(raw.jobs)) return 'has no list of jobs.';
  if (raw.jobs.length > MAX_JOBS) return `has ${raw.jobs.length} jobs; the most one run takes is ${MAX_JOBS}.`;
  const jobs: StabilityJob[] = [];
  for (const [jobIndex, rawJob] of raw.jobs.entries()) {
    const job = checkJob(rawJob, jobIndex);
    if (typeof job === 'string') {
      const jobName = isObject(rawJob) ? text(rawJob.name, 300) : null;
      return `job ${jobIndex}${jobName ? ` (${jobName})` : ''} ${job}`;
    }
    jobs.push(job);
  }
  return { id, workflow, path, status, conclusion, outcome, headSha: raw.headSha, createdAt, url, jobs };
}

/**
 * Checks a whole send. One bad run, job or step refuses all of it, and the
 * error names the run by its position and id, and the job and step inside it.
 */
export function checkRuns(body: unknown): CheckedRuns {
  const list = isObject(body) ? body.runs : undefined;
  if (!Array.isArray(list)) return { ok: false, error: 'The body must be {"runs": [...]}.' };
  if (list.length === 0) return { ok: false, error: 'The send has no runs.' };
  if (list.length > MAX_RUNS) return { ok: false, error: `The send has ${list.length} runs; the most one send takes is ${MAX_RUNS}.` };

  const runs: StabilityRun[] = [];
  const seen = new Set<number>();
  for (const [index, raw] of list.entries()) {
    const result = checkRun(raw);
    const id = isObject(raw) ? wholeOrNull(raw.id, 1) : null;
    const label = `Run ${index}${typeof id === 'number' ? ` (${id})` : ''}`;
    if (typeof result === 'string') return { ok: false, error: `${label}: ${result}` };
    if (seen.has(result.id)) return { ok: false, error: `${label}: is in the send twice.` };
    seen.add(result.id);
    runs.push(result);
  }
  return { ok: true, runs };
}
