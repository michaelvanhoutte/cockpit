/**
 * CI stability's attempts as the Stability job sends them (tools/ci-stability):
 * every attempt of a workflow run, with the branch and pull request it ran for,
 * its jobs and steps where it ran on `main`, and its failed jobs with the tests
 * that failed in each. The Monitor checks their shape and stores them; it
 * derives nothing, so a shard family arrives as one job, Dependabot's runs
 * arrive under one workflow and each outcome arrives decided.
 */
import {
  checkJob,
  isObject,
  MAX_JOBS,
  outcomeOf,
  OUTCOMES,
  SHA,
  conclusionOf,
  text,
  time,
  wholeOrNull,
  type Outcome,
  type StabilityJob,
} from './stability';

/** Most attempts one send may carry. The body is capped too, at the Worker's MAX_BODY characters. */
export const MAX_ATTEMPTS = 50;
/** Most failed tests one failed job names: a record names at most 50, so only a malformed send reaches it. */
export const MAX_FAILED_TESTS = 100;

export interface FailedTest {
  file: string;
  name: string;
  project: string | null;
  error: string | null;
}

export interface FailedJob {
  name: string;
  step: string | null;
  url: string | null;
  tests: FailedTest[];
  testsMore: number;
}

export interface CiAttempt {
  runId: number;
  attempt: number;
  workflow: string;
  path: string;
  event: string;
  branch: string | null;
  pullRequest: number | null;
  onMain: boolean;
  headSha: string;
  status: string;
  conclusion: string | null;
  outcome: Outcome;
  createdAt: number;
  url: string;
  jobs: StabilityJob[];
  failedJobs: FailedJob[];
}

export type CheckedAttempts = { ok: true; attempts: CiAttempt[] } | { ok: false; error: string };

type Fields = Record<string, unknown>;

function optionalText(value: unknown, max: number): string | null | undefined {
  if (value === null || value === undefined) return null;
  return text(value, max, { empty: true }) ?? undefined;
}

function checkTest(raw: unknown): FailedTest | string {
  if (!isObject(raw)) return 'is not an object.';
  const file = text(raw.file, 500);
  if (!file) return 'has no file.';
  const name = text(raw.name, 1000);
  if (!name) return 'has no name.';
  const project = optionalText(raw.project, 100);
  if (project === undefined) return 'has a project that is not a short string.';
  const error = optionalText(raw.error, 500);
  if (error === undefined) return 'has an error that is not a short string.';
  return { file, name, project, error };
}

function checkFailedJob(raw: unknown): FailedJob | string {
  if (!isObject(raw)) return 'is not an object.';
  const name = text(raw.name, 300);
  if (!name) return 'has no name.';
  const step = optionalText(raw.step, 300);
  if (step === undefined) return 'has a step that is not a short string.';
  let url: string | null = null;
  if (raw.url !== null && raw.url !== undefined) {
    url = text(raw.url, 500);
    if (!url?.startsWith('https://')) return 'has a url that is not an https address.';
  }
  const testsMore = raw.testsMore === undefined ? 0 : wholeOrNull(raw.testsMore, 0);
  if (testsMore === null || testsMore === undefined) return `has testsMore ${JSON.stringify(raw.testsMore)}, which is not a whole number, zero or more.`;
  if (!Array.isArray(raw.tests)) return 'has no list of tests.';
  if (raw.tests.length > MAX_FAILED_TESTS) return `has ${raw.tests.length} tests; the most one failed job takes is ${MAX_FAILED_TESTS}.`;
  const tests: FailedTest[] = [];
  for (const [index, rawTest] of raw.tests.entries()) {
    const test = checkTest(rawTest);
    if (typeof test === 'string') return `test ${index} ${test}`;
    tests.push(test);
  }
  return { name, step, url, tests, testsMore };
}

function checkAttempt(raw: unknown): CiAttempt | string {
  if (!isObject(raw)) return 'is not an object.';
  const runId = wholeOrNull(raw.runId, 1);
  if (runId === null || runId === undefined) return 'has no runId.';
  const attempt = wholeOrNull(raw.attempt, 1);
  if (attempt === null || attempt === undefined) return `has attempt ${JSON.stringify(raw.attempt)}, which is not a whole number, one or more.`;
  const workflow = text(raw.workflow, 300);
  if (!workflow) return 'has no workflow.';
  const path = text(raw.path, 300);
  if (!path) return 'has no path.';
  const event = text(raw.event, 100);
  if (!event) return 'has no event.';
  const branch = optionalText(raw.branch, 300);
  if (branch === undefined) return 'has a branch that is not a short string.';
  const pullRequest = wholeOrNull(raw.pullRequest, 1);
  if (pullRequest === undefined) return `has pullRequest ${JSON.stringify(raw.pullRequest)}, which is not a whole number, one or more.`;
  if (typeof raw.onMain !== 'boolean') return 'has an onMain that is not true or false.';
  if (typeof raw.headSha !== 'string' || !SHA.test(raw.headSha)) return 'has a headSha that is not a commit hash.';
  const status = text(raw.status, 50);
  if (!status) return 'has no status.';
  const conclusion = conclusionOf(raw as Fields, status);
  if (conclusion !== null && typeof conclusion === 'object') return conclusion.error;
  const outcome = outcomeOf(raw.outcome);
  if (!outcome) return `has outcome ${JSON.stringify(raw.outcome)}, which is not one of ${OUTCOMES.join(', ')}.`;
  const createdAt = time(raw.createdAt);
  if (createdAt === null || createdAt === undefined) return 'has a createdAt that is not an ISO 8601 timestamp with a time zone.';
  const url = text(raw.url, 500);
  if (!url?.startsWith('https://')) return 'has a url that is not an https address.';

  if (!Array.isArray(raw.jobs)) return 'has no list of jobs.';
  if (raw.jobs.length > MAX_JOBS) return `has ${raw.jobs.length} jobs; the most one attempt takes is ${MAX_JOBS}.`;
  const jobs: StabilityJob[] = [];
  for (const [jobIndex, rawJob] of raw.jobs.entries()) {
    const job = checkJob(rawJob, jobIndex);
    if (typeof job === 'string') {
      const jobName = isObject(rawJob) ? text(rawJob.name, 300) : null;
      return `job ${jobIndex}${jobName ? ` (${jobName})` : ''} ${job}`;
    }
    jobs.push(job);
  }

  if (!Array.isArray(raw.failedJobs)) return 'has no list of failedJobs.';
  if (raw.failedJobs.length > MAX_JOBS) return `has ${raw.failedJobs.length} failed jobs; the most one attempt takes is ${MAX_JOBS}.`;
  const failedJobs: FailedJob[] = [];
  for (const [position, rawFailed] of raw.failedJobs.entries()) {
    const failed = checkFailedJob(rawFailed);
    if (typeof failed === 'string') {
      const failedName = isObject(rawFailed) ? text(rawFailed.name, 300) : null;
      return `failed job ${position}${failedName ? ` (${failedName})` : ''} ${failed}`;
    }
    failedJobs.push(failed);
  }
  return { runId, attempt, workflow, path, event, branch, pullRequest, onMain: raw.onMain, headSha: raw.headSha, status, conclusion, outcome, createdAt, url, jobs, failedJobs };
}

/**
 * Checks a whole send. One bad attempt, job, step, failed job or test refuses
 * all of it, and the error names the attempt by its position, run and attempt
 * number, and the part inside it.
 */
export function checkAttempts(body: unknown): CheckedAttempts {
  const list = isObject(body) ? body.attempts : undefined;
  if (!Array.isArray(list)) return { ok: false, error: 'The body must be {"attempts": [...]}.' };
  if (list.length === 0) return { ok: false, error: 'The send has no attempts.' };
  if (list.length > MAX_ATTEMPTS) return { ok: false, error: `The send has ${list.length} attempts; the most one send takes is ${MAX_ATTEMPTS}.` };

  const attempts: CiAttempt[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of list.entries()) {
    const result = checkAttempt(raw);
    const runId = isObject(raw) ? wholeOrNull(raw.runId, 1) : null;
    const number = isObject(raw) ? wholeOrNull(raw.attempt, 1) : null;
    const label = `Attempt ${index}${typeof runId === 'number' ? ` (run ${runId}${typeof number === 'number' ? `, attempt ${number}` : ''})` : ''}`;
    if (typeof result === 'string') return { ok: false, error: `${label}: ${result}` };
    const key = `${result.runId}:${result.attempt}`;
    if (seen.has(key)) return { ok: false, error: `${label}: is in the send twice.` };
    seen.add(key);
    attempts.push(result);
  }
  return { ok: true, attempts };
}
