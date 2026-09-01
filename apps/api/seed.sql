-- Local development seed: the single tenant and the three workspaces the
-- prototype demonstrates. Idempotent (INSERT OR IGNORE) so it can be re-run.
--
-- `folded_name` is spelled out rather than left to the column default: the
-- default is the empty string, and the unique index would then see three
-- workspaces all called the same nothing and keep only the first. It is the
-- name folded the way src/domain/workspaces.ts folds it, which for three ASCII
-- names is simply their lower case.
INSERT OR IGNORE INTO tenants (id, name, created_at)
VALUES ('tenant-default', 'Michael', '2026-08-12T00:00:00.000Z');

INSERT OR IGNORE INTO workspaces (id, tenant_id, name, folded_name, color, created_at) VALUES
  ('ws-work', 'tenant-default', 'Work', 'work', '#6f62b5', '2026-08-12T00:00:01.000Z'),
  ('ws-atlas', 'tenant-default', 'Atlas Copco', 'atlas copco', '#3a72c8', '2026-08-12T00:00:02.000Z'),
  ('ws-personal', 'tenant-default', 'Personal', 'personal', '#c06a45', '2026-08-12T00:00:03.000Z');
