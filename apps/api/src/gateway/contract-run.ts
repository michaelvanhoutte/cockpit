import type { Recorder, Trigger } from './attempts.js';
import { USAGE_RECORDS_PATH } from './receive.js';
import { sendingTo, type Around } from './send.js';

/**
 * How the contract tier's Claude calls are recorded ("Record every Claude call
 * a contract run makes, as CI or local", issue 1459). The tier constructs the
 * service itself, with no Worker behind it, so it sends each attempt's record to
 * production through the same sender a staging or local Worker uses
 * (`send.ts`), under the token production takes the environment from.
 *
 * Imported by the contract tier alone (`tests/contract/support/claude.ts`),
 * never by the Worker.
 */

/** What a contract run reads from its environment; `process.env` fits. */
export interface RunVariables {
  ANTHROPIC_API_KEY?: string | undefined;
  /** CI's token in a workflow, the local one beside `.dev.vars` by hand: production reads the environment off whichever it is. */
  USAGE_RECORDING_TOKEN?: string | undefined;
  /** Where production's records are taken. */
  USAGE_RECORDING_URL?: string | undefined;
  /** The checkout's branch, which the contract config reads from git for a run by hand. */
  CHECKOUT_BRANCH?: string | undefined;
  GITHUB_ACTIONS?: string | undefined;
  GITHUB_RUN_ID?: string | undefined;
  GITHUB_REF?: string | undefined;
}

/**
 * Whom every contract call is for: nobody. **No user, and what started it
 * reads `contract-run`**; the feature is the prompt's own name, which the call
 * carries as its operation.
 */
export const A_CONTRACT_RUN = { accountName: 'contract-tests', itemId: null, triggeredBy: 'contract-run' } as const satisfies {
  accountName: string;
  itemId: null;
  triggeredBy: Trigger;
};

/** Where a contract run was made: CI with its pull request and run, or a checkout with its branch. */
export type RunPlace =
  | { where: 'ci'; pullRequest: number | null; runId: number }
  | { where: 'local'; branch: string | null };

/**
 * **CI where the GitHub Actions run variables are present, local otherwise.**
 * A pull request is read off the merge ref a `pull_request` run is given
 * (`refs/pull/<number>/merge`); a scheduled or by-hand run is on a branch, so
 * has no pull request to name.
 */
export function placeOfRun(vars: RunVariables): RunPlace {
  if (vars.GITHUB_ACTIONS === 'true' && /^\d+$/.test(vars.GITHUB_RUN_ID ?? '')) {
    const pull = /^refs\/pull\/(\d+)\//.exec(vars.GITHUB_REF ?? '');
    return { where: 'ci', pullRequest: pull ? Number(pull[1]) : null, runId: Number(vars.GITHUB_RUN_ID) };
  }
  return { where: 'local', branch: vars.CHECKOUT_BRANCH || null };
}

/** What is missing for the records to be sent, or `null`. */
function whatRecordingLacks(vars: RunVariables): string | null {
  if (!vars.USAGE_RECORDING_TOKEN) {
    return 'set USAGE_RECORDING_TOKEN: CI’s token in a workflow (the USAGE_TOKEN_CI secret), the local one by hand (apps/api/.dev.vars) - a Claude call is not made without a record of it';
  }
  if (!vars.USAGE_RECORDING_URL) return 'set USAGE_RECORDING_URL to the address the records are sent to - a Claude call is not made without a record of it';
  return null;
}

/**
 * What a contract run needs before it makes a Claude call, or `null` when it
 * has it. **A key with no recording token, or no address to send the records
 * to, counts as no key**, as it does outside production
 * (`environment.ts`): nothing is spent on a key without leaving a row.
 */
export function whatAContractRunLacks(vars: RunVariables): string | null {
  if (!vars.ANTHROPIC_API_KEY) return 'set ANTHROPIC_API_KEY, or put it in apps/api/.dev.vars';
  return whatRecordingLacks(vars);
}

/**
 * The recorder for a contract run's calls: each attempt is sent to production
 * under the run's token, with the pull request and run of a CI run or the
 * branch of a local one, and never with a user. Awaited for about two seconds
 * and never repeated, as the Worker's own sends are.
 */
export function recordingContractRun(vars: RunVariables, around: Pick<Around, 'send' | 'wait'>): Recorder {
  const lacks = whatRecordingLacks(vars);
  if (lacks) throw new Error(lacks);
  const place = placeOfRun(vars);
  return sendingTo(
    { url: new URL(USAGE_RECORDS_PATH, vars.USAGE_RECORDING_URL).href, token: vars.USAGE_RECORDING_TOKEN! },
    {
      ...around,
      userOf: async () => null,
      branch: place.where === 'local' ? place.branch : null,
      pullRequest: place.where === 'ci' ? place.pullRequest : null,
      runId: place.where === 'ci' ? place.runId : null,
    },
  );
}
