import { beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { ACCOUNT_WIDE } from '@cockpit/shared';
import { asUser, seedRegister, signInAs, startFromEmpty } from '../seed.js';

/**
 * Integration level, through the real Worker (`asUser`): whether an address
 * answers, and with what, is a fact about the router, which no lower level
 * reaches ("Remove the two learning settings screens, and the commands that
 * write to them", issue 452).
 *
 * `410` rather than `404`, so a tab still on the previous build is told it is
 * behind and fetches the new one, instead of landing on a failure panel offering
 * Try again (`auth/gate.ts`, `RETIRED_PATHS`).
 */

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await signInAs();
});

describe('What Cockpit has learned', () => {
  describe('what you used to write by hand for it is no longer taken, and says it is retired', () => {
    it.each([
      { situation: 'the rules for how it writes', path: '/v1/commands/set_text_learning_rules' },
      { situation: 'pinning an example', path: '/v1/commands/pin_text_example' },
      { situation: 'editing a pinned example', path: '/v1/commands/edit_pinned_example' },
      { situation: 'deleting a pinned example', path: '/v1/commands/delete_pinned_example' },
      {
        situation: 'the correction to where notes belong',
        path: '/v1/commands/set_routing_summary_correction',
      },
    ])('refuses $situation, to a well-formed request', async ({ path }) => {
      const response = await asUser(`http://cockpit.test${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: '018f0000-0000-7000-8000-000000000001',
          issuedAt: '2026-09-25T10:00:00.000Z',
          workspaceId: ACCOUNT_WIDE,
        }),
      });

      expect(response.status).toBe(410);
    });

    it('no longer shows what it was told', async () => {
      const response = await asUser('http://cockpit.test/v1/text-learning-rules');

      expect(response.status).toBe(410);
    });
  });
});
