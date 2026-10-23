import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_PAGES } from '../../src/claude-calls';
import {
  callLike,
  fakeCockpit,
  giveTheWorkerTheReadToken,
  numberedCalls,
  READ_TOKEN,
  RECORDED_CALLS,
  runTheImport,
  runTheRebuild,
  theCallTotals,
  theCopies,
  thePlace,
  theRoute,
  tokenRefused,
  type CallTotal,
} from './cockpit-support';
import { jobLine, startJob } from './github-support';
import { emptyTheDatabase, recordedFile, theFileAnswers } from './support';

const RECORDED_IDS = RECORDED_CALLS.map((c) => c.id);

/** A total as the recorded calls make it, each its own key. */
const total = (over: Partial<CallTotal>): CallTotal => ({
  day: '',
  environment: 'production',
  feature: '',
  model: '',
  started_by: '',
  pull_request: 0,
  run_id: 0,
  calls: 1,
  cost_micros: 0,
  unpriced_calls: 0,
  ...over,
});

let putBack: () => void;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-23T12:00:00Z') });
  await emptyTheDatabase();
  putBack = giveTheWorkerTheReadToken();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  putBack();
});

describe('Harness Monitor', () => {
  describe("an import copies every new one of Cockpit's Claude calls once, continuing from where the last run stopped", () => {
    it("a first run reads from production's first row and copies every call, under the read token", async () => {
      const calls = fakeCockpit(theRoute(RECORDED_CALLS));

      await runTheImport();

      expect(calls).toEqual([{ after: '0', authorization: `Bearer ${READ_TOKEN}` }]);
      expect(await theCopies()).toEqual(RECORDED_IDS);
      expect(await thePlace()).toBe(1010);
      expect(await theCallTotals()).toEqual([
        total({ day: '2026-10-21', feature: 'clean-up-a-note', model: 'claude-sonnet-4-5', started_by: 'captured-in-app', cost_micros: 5196 }),
        total({ day: '2026-10-22', environment: 'ci', feature: 'clean-up-a-note', model: 'claude-sonnet-4-5', started_by: 'contract-run', pull_request: 1505, run_id: 18829374615, cost_micros: 16701 }),
        total({ day: '2026-10-22', environment: 'ci', feature: 'resolve-a-place', model: 'claude-sonnet-4-5', started_by: 'contract-run', pull_request: 1505, run_id: 18829374615, unpriced_calls: 1 }),
        total({ day: '2026-10-22', environment: 'local', feature: 'propose-for-claude', model: 'claude-opus-4-1', started_by: 'contract-run', unpriced_calls: 1 }),
        total({ day: '2026-10-22', feature: 'choose-a-panel', model: 'claude-haiku-4-5', started_by: 'captured-in-app', cost_micros: 954 }),
        total({ day: '2026-10-23', environment: 'staging', feature: 'remember-a-sentence', model: 'claude-haiku-4-5', started_by: 'captured-in-app', unpriced_calls: 1 }),
      ]);
    });

    it('a later run asks only for the calls after the last one copied', async () => {
      fakeCockpit(theRoute(RECORDED_CALLS.slice(0, 3)));
      await runTheImport();
      vi.restoreAllMocks();

      const calls = fakeCockpit(theRoute(RECORDED_CALLS));
      await runTheImport();

      expect(calls.map((c) => c.after)).toEqual(['1006']);
      expect(await theCopies()).toEqual(RECORDED_IDS);
    });

    it('the same calls served again, to two runs at once, are copied and counted once', async () => {
      // Both runs read from the same place before either stores: the second waits until the first has asked too.
      let release: () => void = () => {};
      const bothAsked = new Promise<void>((resolve) => (release = resolve));
      fakeCockpit(async (call, calls) => {
        if (calls.length === 2) release();
        await bothAsked;
        return theRoute(RECORDED_CALLS)(call);
      });

      const answers = await Promise.all([startJob('claude-calls'), startJob('claude-calls')]);
      const said = await Promise.all(answers.map((a) => a.json() as Promise<{ message: string }>));

      expect(said.map((s) => s.message).sort()).toEqual([
        'Copied 0 Claude calls (6 already here); caught up with Cockpit.',
        'Copied 6 Claude calls; caught up with Cockpit.',
      ]);
      expect(await theCopies()).toEqual(RECORDED_IDS);
      expect((await theCallTotals()).reduce((sum, t) => sum + t.calls, 0)).toBe(6);
    });

    it('calls over several pages are all copied in one run', async () => {
      const calls = fakeCockpit(theRoute(RECORDED_CALLS, 2));

      await runTheImport();

      expect(calls.map((c) => c.after)).toEqual(['0', '1005', '1007']);
      expect(await theCopies()).toEqual(RECORDED_IDS);
    });

    it('a run stops at its cap of pages, stores its place and says there is more; the next run copies the rest', async () => {
      const all = numberedCalls(MAX_PAGES + 2);
      fakeCockpit(theRoute(all, 1));

      const first = await (await startJob('claude-calls')).json();

      expect(first).toEqual({ job: 'claude-calls', ok: true, message: `Copied ${MAX_PAGES} Claude calls; more to read — run it again.` });
      expect(await thePlace()).toBe(MAX_PAGES);
      expect(await theCopies()).toHaveLength(MAX_PAGES);

      const second = await (await startJob('claude-calls')).json();

      expect(second).toEqual({ job: 'claude-calls', ok: true, message: 'Copied 2 Claude calls; caught up with Cockpit.' });
      expect(await theCopies()).toEqual(all.map((c) => c.id));
    });
  });

  describe("the daily totals of Cockpit's Claude calls follow the copies", () => {
    it('a call at 23:30 UTC on 25 October counts on 26 October, its Belgian day', async () => {
      fakeCockpit(theRoute([callLike({ id: 1, at: '2026-10-25T23:30:00.000Z' })]));

      await runTheImport();

      expect((await theCallTotals()).map((t) => t.day)).toEqual(['2026-10-26']);
    });

    it.each([
      { situation: 'environment', over: { environment: 'staging' } },
      { situation: 'feature', over: { feature: 'choose-a-panel' } },
      { situation: 'model', over: { model: 'claude-haiku-4-5' } },
      { situation: 'started by', over: { startedBy: 'contract-run' } },
      { situation: 'pull request', over: { pullRequest: 1505 } },
    ])('calls differing only in $situation are each their own total', async ({ over }) => {
      fakeCockpit(theRoute([callLike({ id: 1 }), callLike({ id: 2, ...over })]));

      await runTheImport();

      expect((await theCallTotals()).map((t) => t.calls)).toEqual([1, 1]);
    });

    it('a call with no price counts as a call, stays out of the dollars and is counted unpriced', async () => {
      fakeCockpit(theRoute([callLike({ id: 1, costUsd: 0.25 }), callLike({ id: 2, costUsd: null })]));

      await runTheImport();

      expect(await theCallTotals()).toEqual([expect.objectContaining({ calls: 2, cost_micros: 250_000, unpriced_calls: 1 })]);
    });

    it("a call keeps production's cost when the Monitor's price list changes", async () => {
      // claude-haiku-4-5 is in the recorded price list, so a repricing would change it.
      fakeCockpit(theRoute([callLike({ id: 1005 }, 1005)]));
      await runTheImport();
      vi.restoreAllMocks();

      theFileAnswers(recordedFile);
      await (await startJob('prices')).json();
      vi.unstubAllGlobals();
      await runTheRebuild();

      const copy = await env.DB.prepare('SELECT cost_micros FROM claude_calls WHERE id = 1005').first<{ cost_micros: number }>();
      expect(copy!.cost_micros).toBe(954);
      expect((await theCallTotals()).map((t) => t.cost_micros)).toEqual([954]);
    });
  });

  describe("a failed import of Cockpit's Claude calls changes nothing and says why; the next run catches up", () => {
    it.each([
      {
        situation: 'production unreachable',
        fail: (): Response => {
          throw new TypeError('Network connection lost.');
        },
        said: 'Could not reach Cockpit: Network connection lost.',
      },
      { situation: 'the token refused', fail: tokenRefused, said: 'Cockpit refused the read token (401).' },
      {
        situation: "an answer not in the route's shape",
        fail: () => Response.json({ calls: [{ ...callLike({ id: 1004 }), userId: 'user-anna' }], more: false }),
        said: `Cockpit's answer is not a page of calls: Call 0 (row 1004) carries "userId", which a call does not have.`,
      },
      { situation: 'a failure on the second page', fail: () => new Response('down', { status: 500 }), said: 'Cockpit answered 500.', onPage: 2 },
    ])('$situation', async ({ fail, said, onPage = 1 }) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      let broken = true;
      fakeCockpit((call, calls) => (broken && calls.length >= onPage ? fail() : theRoute(RECORDED_CALLS, 3)(call)));

      const failed = await (await startJob('claude-calls')).json();

      expect(failed).toEqual({ job: 'claude-calls', ok: false, message: `${said} Nothing was copied.` });
      expect(await jobLine('claude-calls')).toContain(said);
      expect(await theCopies()).toEqual([]);
      expect(await theCallTotals()).toEqual([]);
      expect(await thePlace()).toBeNull();

      broken = false;
      await runTheImport();

      expect(await theCopies()).toEqual(RECORDED_IDS);
      expect((await theCallTotals()).reduce((sum, t) => sum + t.calls, 0)).toBe(6);
    });
  });

  describe("the import of Cockpit's Claude calls runs on its schedule or by hand, and says what it did", () => {
    it('its cron firing runs it, recorded as scheduled on the costs page', async () => {
      fakeCockpit(theRoute(RECORDED_CALLS));

      await runTheImport();

      expect(await theCopies()).toEqual(RECORDED_IDS);
      expect(await jobLine('claude-calls')).toBe(
        "Cockpit's Claude calls: last run 23 Oct 2026, 14:00 (scheduled) — Copied 6 Claude calls; caught up with Cockpit.",
      );
    });

    it('started by hand with the write key, it runs and answers with its outcome, listed as by hand', async () => {
      fakeCockpit(theRoute(RECORDED_CALLS));

      const response = await startJob('claude-calls');

      expect(await response.json()).toEqual({ job: 'claude-calls', ok: true, message: 'Copied 6 Claude calls; caught up with Cockpit.' });
      expect(await jobLine('claude-calls')).toContain('(by hand)');
    });

    it('started by hand without the write key, it is refused and nothing is read', async () => {
      const calls = fakeCockpit(theRoute(RECORDED_CALLS));

      const response = await startJob('claude-calls', { authorization: 'Bearer not-the-key' });

      expect(response.status).toBe(401);
      expect(calls).toEqual([]);
      expect(await theCopies()).toEqual([]);
    });

    it.each([
      { situation: 'no read token', unset: 'USAGE_READ_TOKEN' as const },
      { situation: "no Cockpit address", unset: 'COCKPIT_URL' as const },
    ])('with $situation set, it records itself as skipped', async ({ unset }) => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const calls = fakeCockpit(theRoute(RECORDED_CALLS));
      delete env[unset];

      const response = await startJob('claude-calls');

      expect(await response.json()).toEqual({ job: 'claude-calls', ok: false, message: 'Skipped: USAGE_READ_TOKEN or COCKPIT_URL is not set on the Worker.' });
      expect(await jobLine('claude-calls')).toContain('Skipped: USAGE_READ_TOKEN or COCKPIT_URL is not set on the Worker.');
      expect(calls).toEqual([]);
    });

    it("before its first run, the costs page's job list says it has not run", async () => {
      expect(await jobLine('claude-calls')).toBe("Cockpit's Claude calls: has not run yet.");
    });
  });
});
