import { beforeAll, describe, expect, inject, it } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';

/**
 * Integration level, and its own file: what it arranges is a database in a
 * state no other test wants - two workspaces the new rule says cannot both
 * exist - and applying an update can only happen once.
 *
 * The rule it pins is a decision, not an accident. Staging is deliberately
 * never re-seeded and production is a person's real data, so either could
 * already hold two workspaces whose names differ only in case. Renaming one of
 * them to get the deploy through would be silently editing something the person
 * named; refusing stops the deploy with the old code still serving the old
 * schema, and costs one rename by hand. If this ever goes green because the
 * index stopped being unique, or because the update started choosing a winner,
 * that decision was reversed without anyone saying so.
 */
const AT = '2026-08-12T10:00:00.000Z';
const TENANT_ID = 'tenant-default';

/** Everything up to and including the rebuild, before names had to be unique. */
function beforeNamesHadToBeUnique() {
  return inject('migrations').filter((m) => m.name.startsWith('0000') || m.name.startsWith('0001'));
}
function theRest() {
  return inject('migrations').filter(
    (m) => !m.name.startsWith('0000') && !m.name.startsWith('0001'),
  );
}

let refusal: unknown;

beforeAll(async () => {
  await applyD1Migrations(env.DB, beforeNamesHadToBeUnique());
  await env.DB.batch([
    env.DB.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)').bind(
      TENANT_ID,
      'Michael',
      AT,
    ),
    env.DB.prepare(
      `INSERT INTO workspaces (id, tenant_id, name, slug, color, created_at) VALUES
         ('ws-work', ?, 'Work', 'work', '#6f62b5', ?),
         ('ws-work-again', ?, 'work', 'work-again', '#3a72c8', ?)`,
    ).bind(TENANT_ID, AT, TENANT_ID, AT),
  ]);

  refusal = await applyD1Migrations(env.DB, theRest()).then(
    () => null,
    (error: unknown) => error,
  );
});

describe('Workspace management', () => {
  describe('two workspaces that were named the same stop an update rather than one being renamed', () => {
    it('refuses to finish', () => {
      expect(refusal).toBeInstanceOf(Error);
    });

    it('leaves both workspaces exactly as they were', async () => {
      const { results } = await env.DB.prepare(
        'SELECT id, name FROM workspaces ORDER BY id',
      ).all<{ id: string; name: string }>();

      expect(results).toEqual([
        { id: 'ws-work', name: 'Work' },
        { id: 'ws-work-again', name: 'work' },
      ]);
    });
  });
});
