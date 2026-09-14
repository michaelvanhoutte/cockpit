import { beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { ACCOUNT_WIDE } from '@cockpit/shared';
import {
  ACCOUNT_NAME,
  OTHER_ACCOUNT_NAME,
  OTHER_USER_ID,
  asUser,
  inStoreAsItIs,
  seedRegister,
  signInAs,
  startFromEmpty,
  storeNamed,
} from '../seed.js';

/**
 * Integration level, through the real Worker (`asUser`), for the reason
 * `routing-summary-correction.test.ts` beside this file is: whether a rule
 * lands, clears, or leaves the row untouched is a fact about the store, not
 * about a pure function ("Show what Cockpit is told, and say how you want it
 * changed", issue 398).
 */

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}

const AT = '2026-09-10T10:00:00.000Z';

async function setRules(rules: string, userId?: string) {
  return asUser(
    'http://cockpit.test/v1/commands/set_text_learning_rules',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: nextId(), issuedAt: AT, workspaceId: ACCOUNT_WIDE, rules }),
    },
    userId,
  );
}

/**
 * Brought up to date first, unlike a bare `inStoreAsItIs` - a store nothing
 * has opened yet has no `account_text_rules` table at all
 * (`accounts/changes.ts`), which several cases here read before ever sending
 * a command that would open it.
 */
async function rowFor(accountName: string) {
  const opened = await storeNamed(accountName).workspaces(accountName);
  if (opened.status !== 'ok') throw new Error(JSON.stringify(opened));
  const rows = await inStoreAsItIs(accountName, (sql) =>
    sql
      .exec<{ rules: string | null; rules_set_at: string | null }>(
        'SELECT rules, rules_set_at FROM account_text_rules WHERE tenant_id = ?',
        accountName,
      )
      .toArray(),
  );
  return rows[0] ?? null;
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await signInAs();
  await signInAs(OTHER_USER_ID);
  seq = 0;
});

describe('What Cockpit is told', () => {
  describe('writing a rule', () => {
    it('creates the row where none exists yet', async () => {
      expect(await rowFor(ACCOUNT_NAME)).toBeNull();

      expect((await setRules('Never end a title with a question mark.')).status).toBe(200);

      expect(await rowFor(ACCOUNT_NAME)).toMatchObject({
        rules: 'Never end a title with a question mark.',
        rules_set_at: AT,
      });
    });

    it('replaces an earlier rule rather than adding to it', async () => {
      await setRules('First rule.');

      expect((await setRules('Second, replacing the first.')).status).toBe(200);

      expect((await rowFor(ACCOUNT_NAME))?.rules).toBe('Second, replacing the first.');
    });

    it('clears the rule back to null when sent the empty string, timestamp included', async () => {
      await setRules('Never end a title with a question mark.');

      expect((await setRules('')).status).toBe(200);

      const row = await rowFor(ACCOUNT_NAME);
      expect(row?.rules).toBeNull();
      // Null on both, or "set to nothing" would carry a timestamp for a rule
      // that no longer exists - a third state `domain/text-learning-
      // rules.ts` says there is none of.
      expect(row?.rules_set_at).toBeNull();
    });

    it('is refused when it runs well over the cap, before it ever reaches the store', async () => {
      const response = await setRules('x'.repeat(2_001));
      expect(response.status).not.toBe(200);
      expect(await rowFor(ACCOUNT_NAME)).toBeNull();
    });

    it('writes the rule once, not twice, when the same command is replayed', async () => {
      const body = {
        commandId: nextId(),
        issuedAt: AT,
        workspaceId: ACCOUNT_WIDE,
        rules: 'Never end a title with a question mark.',
      };
      const once = () =>
        asUser('http://cockpit.test/v1/commands/set_text_learning_rules', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });

      const first = await once();
      const second = await once();

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(((await second.json()) as { applied: boolean }).applied).toBe(false);
    });

    it('never reaches another account’s row', async () => {
      expect((await setRules('Their own way of writing it.', OTHER_USER_ID)).status).toBe(200);

      expect(await rowFor(ACCOUNT_NAME)).toBeNull();
      expect((await rowFor(OTHER_ACCOUNT_NAME))?.rules).toBe('Their own way of writing it.');
    });
  });

  /**
   * The read half - its own route, not a slice of the workspace snapshot,
   * the same reason `item-types` has one ("Show what Cockpit is told, and
   * say how you want it changed", issue 398).
   */
  describe('reading it back', () => {
    async function read() {
      const response = await asUser('http://cockpit.test/v1/text-learning-rules');
      expect(response.status).toBe(200);
      return (await response.json()) as {
        rules: string | null;
        rulesSetAt: string | null;
        proposedTotal: number;
        correctedTotal: number;
      };
    }

    it('reads null and zeroes for an account that has written nothing and proposed nothing', async () => {
      const status = await read();
      expect(status.rules).toBeNull();
      expect(status.rulesSetAt).toBeNull();
      expect(status.proposedTotal).toBe(0);
      expect(status.correctedTotal).toBe(0);
    });

    it('reads back a rule just written', async () => {
      await setRules('Never end a title with a question mark.');

      const status = await read();
      expect(status.rules).toBe('Never end a title with a question mark.');
      expect(status.rulesSetAt).toBe(AT);
    });

    it('never reads back a rule written in another account', async () => {
      await setRules('Their own way of writing it.', OTHER_USER_ID);

      expect((await read()).rules).toBeNull();
    });
  });
});
