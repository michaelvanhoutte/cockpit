import { beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import { demoPageOf } from '@cockpit/shared';
import type { AgentRun, WorkspaceSnapshot } from '@cockpit/shared';
import { GUEST_ACCOUNT_NAME } from '../../../src/accounts/new-user.js';
import { inStoreAsItIs, seedRegister, startFromEmpty } from '../seed.js';

/**
 * Integration level, through the real Worker: what the guest demonstration
 * shows of Claude once Agents were retired ("Retire the agents' dock and
 * routines, keeping what each agent knew", issue 1165) - Items sent to Cowork or
 * Claude Code at every stage, and no Agent. Which Items carry a send is the
 * seed's own (apps/api/tests/unit/accounts/guest-demo-seed.test.ts), and its
 * connections are guest-demo.test.ts's; this is that the rebuilt account
 * serves the sends.
 */

async function continueAsGuest(): Promise<string> {
  const back = await SELF.fetch('http://cockpit.test/v1/sign-in/guest', { redirect: 'manual' });
  return back.headers
    .getSetCookie()
    .map((one) => one.split(';')[0]!)
    .find((one) => one.startsWith('cockpit_session='))!;
}

let cookie: string;

async function workspaces(): Promise<{ id: string }[]> {
  const res = await SELF.fetch('http://cockpit.test/v1/workspaces', { headers: { cookie } });
  return ((await res.json()) as { workspaces: { id: string }[] }).workspaces;
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  cookie = await continueAsGuest();
});

describe('Agents', () => {
  describe('the guest opens on Items sent to Claude, and no Agent', () => {
    it('shows Runs sent to Cowork and Code, sent, on it, ready and needing you, and holds no Agent', async () => {
      const agentRuns: AgentRun[] = [];
      for (const workspace of await workspaces()) {
        const res = await SELF.fetch(`http://cockpit.test/v1/workspaces/${workspace.id}/snapshot`, { headers: { cookie } });
        expect(res.status).toBe(200);
        agentRuns.push(...((await res.json()) as WorkspaceSnapshot).agentRuns);
      }

      expect(agentRuns.length).toBeGreaterThan(0);
      for (const run of agentRuns) {
        expect(run.destination, run.id).not.toBeNull();
        expect(run.agentName, run.id).toBeNull();
        // A Run Claude reported on opens the demo's own session page; one only sent has no session yet.
        if (run.stage === 'sent') expect(run.sessionUrl, run.id).toBeNull();
        else expect(demoPageOf(run.sessionUrl!), run.id).toBe('session');
      }
      expect(new Set(agentRuns.map((run) => run.stage))).toEqual(new Set(['sent', 'on_it', 'ready', 'needs_you']));

      const agents = await inStoreAsItIs(GUEST_ACCOUNT_NAME, (sql) =>
        sql.exec<{ n: number }>('SELECT count(*) AS n FROM agents').one().n,
      );
      expect(agents).toBe(0);
    });
  });
});
