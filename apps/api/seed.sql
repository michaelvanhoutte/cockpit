-- Local development seed: the single tenant and the three workspaces the
-- prototype demonstrates. Idempotent (INSERT OR IGNORE) so it can be re-run.
INSERT OR IGNORE INTO tenants (id, name, created_at)
VALUES ('tenant-default', 'Michael', '2026-08-12T00:00:00.000Z');

INSERT OR IGNORE INTO workspaces (id, tenant_id, name, slug, color, created_at) VALUES
  ('ws-work', 'tenant-default', 'Work', 'work', '#6f62b5', '2026-08-12T00:00:01.000Z'),
  ('ws-atlas', 'tenant-default', 'Atlas Copco', 'atlas', '#3a72c8', '2026-08-12T00:00:02.000Z'),
  ('ws-personal', 'tenant-default', 'Personal', 'personal', '#c06a45', '2026-08-12T00:00:03.000Z');
