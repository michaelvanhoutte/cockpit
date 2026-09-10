import { beforeEach, afterEach, describe, expect, inject, it, vi } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import {
  ACCOUNT_NAME,
  OTHER_ACCOUNT_NAME,
  WORKSPACE_ID,
  alsoWorkspaces,
  asUser,
  seedRegister,
  signInAs,
  startFromEmpty,
} from '../seed.js';
import { handleScheduled } from '../../../src/jobs/index.js';

/**
 * Integration level, against the real register and the real per-account
 * stores: what Cron Triggers actually run, for the first time, once a night
 * ("Show what the system learned, in a sentence you can correct", issue
 * 301). What each queued job does once it reaches the consumer is
 * `routing-summary-job.test.ts`'s question - this file is only about the
 * fan-out: which accounts and Workspaces get a message at all.
 */

async function run(): Promise<void> {
  // `ScheduledController` is not otherwise used by `handleScheduled` (the
  // single cron schedule wrangler.jsonc declares is the only one there is to
  // dispatch on), so an empty stand-in is the whole of what a test needs.
  await handleScheduled({} as never, env);
}

function queued(): { accountName: string; workspaceId: string }[] {
  return sent.mock.calls.map(([job]: [unknown]) => job as { accountName: string; workspaceId: string });
}

let sent: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  env.ANTHROPIC_API_KEY = 'a-key-that-proves-nothing-here';
  sent = vi.spyOn(env.ENRICHMENT, 'send');
});

afterEach(() => {
  env.ANTHROPIC_API_KEY = '';
  vi.restoreAllMocks();
});

describe('What Cockpit has learned', () => {
  describe('the nightly fan-out', () => {
    it('queues one summarize-workspace message for the one workspace an account starts with', async () => {
      await run();

      const mine = queued().filter((job) => job.accountName === ACCOUNT_NAME);
      expect(mine).toEqual([{ kind: 'summarize-workspace', accountName: ACCOUNT_NAME, workspaceId: WORKSPACE_ID }]);
    });

    it('queues one message per workspace, for an account with several', async () => {
      await alsoWorkspaces();

      await run();

      const mine = queued().filter((job) => job.accountName === ACCOUNT_NAME);
      expect(mine.map((job) => job.workspaceId).sort()).toEqual(['ws-1', 'ws-atlas', 'ws-personal'].sort());
    });

    it('reaches every registered account, not only the first', async () => {
      await run();

      expect(queued().some((job) => job.accountName === ACCOUNT_NAME)).toBe(true);
      expect(queued().some((job) => job.accountName === OTHER_ACCOUNT_NAME)).toBe(true);
    });

    it('never queues a workspace that has been deleted', async () => {
      await alsoWorkspaces();
      // Signed in so there is a session to delete with - the fan-out itself
      // needs no session at all, only this arrangement step does.
      await signInAs();
      expect(
        (
          await asUser('http://cockpit.test/v1/commands/delete_workspace', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              commandId: '018f0000-0000-7000-8000-000000000099',
              issuedAt: '2026-09-10T02:00:00.000Z',
              workspaceId: 'ws-atlas',
            }),
          })
        ).status,
      ).toBe(200);

      await run();

      const mine = queued().filter((job) => job.accountName === ACCOUNT_NAME);
      expect(mine.map((job) => job.workspaceId)).not.toContain('ws-atlas');
    });

    it('queues nothing where this environment has no key to summarize with', async () => {
      env.ANTHROPIC_API_KEY = '';

      await run();

      expect(sent).not.toHaveBeenCalled();
    });
  });
});
