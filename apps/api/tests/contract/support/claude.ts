import type Anthropic from '@anthropic-ai/sdk';
import { expect, it } from 'vitest';
import { ClaudeAiService } from '../../../src/ai/index.js';
import { A_CONTRACT_RUN, recordingContractRun, whatAContractRunLacks } from '../../../src/gateway/contract-run.js';

/**
 * How every contract suite asks Claude: **each attempt is recorded in
 * production**, as CI or as local ("Record every Claude call a contract run
 * makes, as CI or local", issue 1459). The service is built here and nowhere
 * else in this tier, so no call is made without a token and an address to
 * record it under. A send production refuses or does not answer is logged and
 * costs that one row, never the call.
 */

export { A_CONTRACT_RUN };

/** The key, or an empty string: a red check without one, never a skipped one. */
const key = process.env.ANTHROPIC_API_KEY ?? '';

/** What this run is missing before it may call Claude, or `null`. */
const lacking = whatAContractRunLacks(process.env);

/**
 * A service that records each attempt in production, and hears each
 * successful call's usage for the suite's own tally. **Without everything a
 * run needs it holds no key**, so a call fails inside the SDK before anything
 * is sent: the check below is what names what is missing, and nothing is
 * spent while it is red.
 */
export function claude(onUsage?: (model: string, usage: Anthropic.Usage) => void): ClaudeAiService {
  return new ClaudeAiService(
    lacking === null ? key : '',
    process.env.ANTHROPIC_WORKSPACE_ID || undefined,
    onUsage,
    lacking === null
      ? recordingContractRun(process.env, {
          send: (url, init) => fetch(url, init),
          wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        })
      : async () => {},
  );
}

/** Red, naming what a contract run lacks, rather than a run that asked nothing or spent unrecorded. */
export function expectAKeyAndARecord(): void {
  expect(lacking, lacking ?? '').toBeNull();
}

/** The check above as a test of its own. */
export function hasAKey() {
  it('has a key to ask with and a token to record its calls under', expectAKeyAndARecord);
}
