import { beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { ACCOUNT_WIDE } from '@cockpit/shared';
import { WORKSPACE_ID, asUser, seedRegister, signInAs, startFromEmpty } from '../seed.js';

/**
 * Integration level, through the real Worker (`asUser`): whether a route
 * exists is a fact about the router, which no lower level reaches ("Remove the
 * two learning settings screens, and the commands that write to them", issue
 * 452).
 */

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await signInAs();
});

describe('What Cockpit has learned', () => {
  describe('the commands that hand-wrote what Cockpit learns from can no longer be issued', () => {
    it.each([
      'set_text_learning_rules',
      'pin_text_example',
      'edit_pinned_example',
      'delete_pinned_example',
      'set_routing_summary_correction',
    ])('refuses %s as unknown', async (name) => {
      const response = await asUser(`http://cockpit.test/v1/commands/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: '018f0000-0000-7000-8000-000000000001',
          issuedAt: '2026-09-25T10:00:00.000Z',
          workspaceId: ACCOUNT_WIDE,
          workspace: WORKSPACE_ID,
        }),
      });

      expect(response.status).toBe(404);
    });

    it('no longer serves the read that showed them', async () => {
      const response = await asUser('http://cockpit.test/v1/text-learning-rules');

      expect(response.status).toBe(404);
    });
  });
});
