-- The register: which accounts exist and who the people are. Idempotent
-- (INSERT OR IGNORE) so it can be re-run.
--
-- Two users, each owning an account of their own, because one proves nothing
-- about the boundary between them ("Sign in by picking a name, each user in
-- their own account", issue 86). Nothing is shared: separate accounts means
-- separate stores, and the platform cannot join across them.
--
-- Adding a third from the command line is its own piece of work; this file is
-- what a fresh environment starts with.
--
-- **No sessions are seeded.** A sign-in is something a person does, and a row
-- put here would be a credential checked into a public repository.
--
-- The workspaces this file used to create are gone from here, not because they
-- are gone from the product but because they are no longer in this database. An
-- account's workspaces live in that account's own store, and nothing can reach
-- a Durable Object from the outside to seed it - `wrangler d1 execute` speaks
-- to D1, and a store does not exist until a request opens it. Each account's
-- workspaces are now its own first change instead (src/accounts/changes.ts),
-- applied once, the first time somebody signs in and opens it.
INSERT OR IGNORE INTO tenants (id, name, created_at)
VALUES ('tenant-default', 'Michael', '2026-08-12T00:00:00.000Z'),
       ('tenant-ada', 'Ada', '2026-09-01T00:00:00.000Z');

-- `role` is carried and nothing reads it to decide anything yet; see the
-- migration that added the column for why it is here now rather than later.
INSERT OR IGNORE INTO users (id, name, account_id, role, created_at)
VALUES ('user-michael', 'Michael', 'tenant-default', 'admin', '2026-08-12T00:00:00.000Z'),
       ('user-ada', 'Ada', 'tenant-ada', 'user', '2026-09-01T00:00:00.000Z');
