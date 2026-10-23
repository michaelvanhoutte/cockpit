import { describe, expect, it } from 'vitest';
import type { AttemptRecord } from '../../../src/gateway/attempts.js';
import {
  A_CONTRACT_RUN,
  recordingContractRun,
  whatAContractRunLacks,
  type RunVariables,
} from '../../../src/gateway/contract-run.js';

/**
 * Unit level: what a contract run's record says is decided from the run's
 * environment variables, so they are handed in, and so is the network. What
 * production does with the record, and the rule that it reads the environment
 * off the token, are the integration tier's
 * (tests/integration/http/ai-usage-from-other-environments.test.ts).
 */

const TOKEN = 'the-token-this-run-records-under';
const PRODUCTION = 'https://production.test';

const A_KEY_AND_A_PLACE: RunVariables = {
  ANTHROPIC_API_KEY: 'sk-ant-a-key',
  USAGE_RECORDING_TOKEN: TOKEN,
  USAGE_RECORDING_URL: PRODUCTION,
};

/** An attempt as the service settles it, made for a contract run as every contract call is. */
const ATTEMPT: AttemptRecord = {
  ...A_CONTRACT_RUN,
  operation: 'clean-up-a-note',
  promptVersion: 'clean-up-a-note.v17',
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  paidBy: { kind: 'cockpit-anthropic-key', account: null, keyEnding: 'WXYZ' },
  outcome: 'ok',
  tokensIn: 1200,
  cacheRead: 3400,
  cacheWrite: 560,
  tokensOut: 78,
  at: '2026-10-23T10:00:00.000Z',
  durationMs: 812,
};

/** What the run sent to production for one attempt. */
async function recordedFor(vars: RunVariables) {
  const sent: { url: string; init: RequestInit }[] = [];
  const record = recordingContractRun(vars, {
    send: async (url, init) => {
      sent.push({ url, init });
      return new Response(null, { status: 201 });
    },
    wait: () => new Promise(() => {}),
  });
  await record(ATTEMPT);
  expect(sent).toHaveLength(1);
  return {
    url: sent[0]!.url,
    authorization: new Headers(sent[0]!.init.headers).get('authorization'),
    body: JSON.parse(String(sent[0]!.init.body)) as Record<string, unknown>,
  };
}

describe('AI usage', () => {
  describe('a contract run’s calls are recorded as CI or local, as a contract run, with no user', () => {
    it.each([
      {
        situation: 'a run in GitHub Actions on a pull request',
        vars: { GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '18273645501', GITHUB_REF: 'refs/pull/1459/merge', CHECKOUT_BRANCH: '' },
        place: { pullRequest: 1459, runId: 18273645501, branch: null },
      },
      {
        situation: 'a scheduled run in GitHub Actions, which is on a branch and has no pull request',
        vars: { GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '18273645502', GITHUB_REF: 'refs/heads/main', CHECKOUT_BRANCH: '' },
        place: { pullRequest: null, runId: 18273645502, branch: null },
      },
      {
        situation: 'a run by hand in a checkout',
        vars: { CHECKOUT_BRANCH: 'claude/1459-record-contract-runs' },
        place: { pullRequest: null, runId: null, branch: 'claude/1459-record-contract-runs' },
      },
      {
        situation: 'a run by hand that cannot say its branch',
        vars: { CHECKOUT_BRANCH: '' },
        place: { pullRequest: null, runId: null, branch: null },
      },
      {
        situation: 'a run that has the GitHub Actions flag but no run to name',
        vars: { GITHUB_ACTIONS: 'true', CHECKOUT_BRANCH: 'claude/1459-record-contract-runs' },
        place: { pullRequest: null, runId: null, branch: 'claude/1459-record-contract-runs' },
      },
    ])('sends $situation to production under its token', async ({ vars, place }) => {
      const sent = await recordedFor({ ...A_KEY_AND_A_PLACE, ...vars });

      expect(sent.url).toBe(`${PRODUCTION}/v1/usage-records`);
      expect(sent.authorization).toBe(`Bearer ${TOKEN}`);
      expect(sent.body.branch).toBe(place.branch);
      // A pull request or run a run has none of is left out of the body, which production reads as none.
      if (place.pullRequest === null) expect(sent.body).not.toHaveProperty('pullRequest');
      else expect(sent.body.pullRequest).toBe(place.pullRequest);
      if (place.runId === null) expect(sent.body).not.toHaveProperty('runId');
      else expect(sent.body.runId).toBe(place.runId);
    });

    it('names no user, and the contract run as what started a call to the prompt it exercised', async () => {
      const sent = await recordedFor(A_KEY_AND_A_PLACE);

      expect(sent.body).toMatchObject({ userId: null, triggeredBy: 'contract-run', operation: 'clean-up-a-note' });
    });
  });

  describe('a contract run with a Claude key and no recording token is red before any call', () => {
    it.each([
      { situation: 'a key, a token and an address', vars: A_KEY_AND_A_PLACE, lacks: null },
      { situation: 'a key and no token', vars: { ...A_KEY_AND_A_PLACE, USAGE_RECORDING_TOKEN: '' }, lacks: 'USAGE_RECORDING_TOKEN' },
      { situation: 'a key and a token that was never set', vars: { ...A_KEY_AND_A_PLACE, USAGE_RECORDING_TOKEN: undefined }, lacks: 'USAGE_RECORDING_TOKEN' },
      { situation: 'a key and a token with no address to send to', vars: { ...A_KEY_AND_A_PLACE, USAGE_RECORDING_URL: '' }, lacks: 'USAGE_RECORDING_URL' },
      { situation: 'no key, whatever else it has', vars: { ...A_KEY_AND_A_PLACE, ANTHROPIC_API_KEY: '' }, lacks: 'ANTHROPIC_API_KEY' },
      { situation: 'nothing at all', vars: {}, lacks: 'ANTHROPIC_API_KEY' },
    ])('names what is missing with $situation', ({ vars, lacks }) => {
      const missing = whatAContractRunLacks(vars);

      if (lacks === null) expect(missing).toBeNull();
      else expect(missing).toContain(lacks);
    });

    it('never names the token in what it says is missing', () => {
      expect(whatAContractRunLacks({ ...A_KEY_AND_A_PLACE, USAGE_RECORDING_URL: '' })).not.toContain(TOKEN);
    });

    it('refuses to be given a recorder where it has no token, rather than make calls nobody records', () => {
      expect(() => recordingContractRun({ ...A_KEY_AND_A_PLACE, USAGE_RECORDING_TOKEN: '' }, { send: async () => new Response(), wait: async () => {} })).toThrow(
        'USAGE_RECORDING_TOKEN',
      );
    });
  });
});
