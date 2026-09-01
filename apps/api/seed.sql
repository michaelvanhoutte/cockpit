-- The register: the one account this application has. Idempotent
-- (INSERT OR IGNORE) so it can be re-run.
--
-- The workspaces it used to create are gone from here, not because they are
-- gone from the product but because they are no longer in this database. An
-- account's workspaces live in that account's own store, and nothing can reach
-- a Durable Object from the outside to seed it - `wrangler d1 execute` speaks
-- to D1, and a store does not exist until a request opens it. The three
-- workspaces are now the account's first change instead
-- (src/accounts/changes.ts), applied once, the first time somebody opens it.
INSERT OR IGNORE INTO tenants (id, name, created_at)
VALUES ('tenant-default', 'Michael', '2026-08-12T00:00:00.000Z');
