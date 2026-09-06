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
--
-- **The addresses are placeholders, and unusable on purpose.** This file is in a
-- public repository, so no real address is in it - and `example.com` is reserved,
-- so no Google account can ever hold one of these. Locally that costs nothing,
-- because signing in does not ask Google who you are yet. Putting a real address
-- on a deployed environment is a step of "Sign in with Google, and retire the
-- list of names" (issue 196), by hand. Until then these addresses do nothing at
-- all: you sign in by picking a name off the logon page, and both of these
-- people are as reachable as they were before the column existed.
--
-- `google_subject` is left empty for both, because it is not something to decide:
-- it is what Google says about a person the first time they sign in.
INSERT OR IGNORE INTO users (id, name, account_id, role, email, created_at)
VALUES ('user-michael', 'Michael', 'tenant-default', 'admin', 'michael@example.com', '2026-08-12T00:00:00.000Z'),
       ('user-ada', 'Ada', 'tenant-ada', 'user', 'ada@example.com', '2026-09-01T00:00:00.000Z');
