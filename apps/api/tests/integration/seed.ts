import { env } from 'cloudflare:test';

/**
 * Migrations create the schema; seed.sql creates the single tenant and its
 * workspaces, and only `pnpm dev` runs that. Foreign keys mean an item cannot
 * be filed until those rows exist, so every test that writes one seeds first.
 *
 * Kept in step with seed.sql by hand - it is two rows, and importing a .sql
 * file into the workers pool costs more than it saves.
 */
export const TENANT_ID = 'tenant-default';
export const WORKSPACE_ID = 'ws-work';

export async function seedWorkspaces(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO tenants (id, name, created_at) VALUES (?, ?, ?)').bind(
      TENANT_ID,
      'Michael',
      '2026-08-12T00:00:00.000Z',
    ),
    env.DB.prepare(
      'INSERT OR IGNORE INTO workspaces (id, tenant_id, name, folded_name, color, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(WORKSPACE_ID, TENANT_ID, 'Work', 'work', '#6f62b5', '2026-08-12T00:00:01.000Z'),
  ]);
}
