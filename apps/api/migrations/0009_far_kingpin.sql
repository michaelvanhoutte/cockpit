-- The register learns who the people are and which of them are signed in
-- ("Sign in by picking a name, each user in their own account", issue 86).
--
-- Both tables belong in D1 rather than in an account's store for the reason the
-- register itself is here: they are read *before* any account is known. The
-- cookie on the request names a row in `sessions`, that row names a row in
-- `users`, and only then is there an account to open. A store addressed by
-- account name cannot answer a question asked to find out which account name to
-- use.
--
-- **`role` ships as data with nothing enforcing it**, deliberately. There is no
-- admin-only page yet, so a gate here would be a branch no test could ever take
-- for a real reason; the column exists now so that role logic is in the schema
-- from the start rather than retrofitted through every query later. The first
-- admin-only page brings the check and the first test of it.
--
-- **There is no secret column, and there will not be one.** A passwordless list
-- of names is an identity selector, not an authentication control, which is why
-- Cloudflare Access stays in front of every deployed environment (architecture,
-- "App login: hand-rolled Google OIDC + own sessions"; deployment, "The cost of
-- gating production, stated plainly"). Google sign-in adds what it needs to
-- `users` when it lands and drops none of this.
--
-- **STRICT and the CHECKs by hand**, as every migration in this directory does:
-- drizzle-kit cannot emit STRICT, so it is added after generating and
-- tests/integration/db/constraints.test.ts is what notices if a regenerated
-- migration quietly drops it.
--
-- **If it fails partway through, and if it runs again.** Three statements, all
-- pure DDL against tables that do not exist yet, so none can fail on the data
-- it finds - there is no data. None is re-runnable: SQLite has no
-- `CREATE TABLE IF NOT EXISTS` in what drizzle emits and none is added here,
-- because a re-run means the migration ledger and the schema disagree, which is
-- a thing to notice rather than to paper over. A run interrupted between the
-- statements leaves `users` without `sessions`: nobody can sign in, everybody is
-- refused, and nothing is lost - the retry finishes the job. There is no state
-- here in which existing data is unreadable, because this touches none.
--
-- **Nothing is seeded here.** Which people exist is bootstrap data, and it lives
-- in seed.sql beside the account it belongs to (deployment, "Bootstrapping a new
-- environment"), so that an environment that is deliberately never re-seeded is
-- not given users behind its own back.
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`account_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "users_role_is_known" CHECK(role IN ('user', 'admin')),
	CONSTRAINT "users_created_at_is_timestamp" CHECK(created_at IS NULL OR (datetime(created_at) IS NOT NULL AND substr(created_at, 11, 1) = 'T' AND substr(created_at, -1) = 'Z' AND length(created_at) >= 20 AND date(created_at) = substr(created_at, 1, 10)))
) STRICT;--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sessions_created_at_is_timestamp" CHECK(created_at IS NULL OR (datetime(created_at) IS NOT NULL AND substr(created_at, 11, 1) = 'T' AND substr(created_at, -1) = 'Z' AND length(created_at) >= 20 AND date(created_at) = substr(created_at, 1, 10))),
	CONSTRAINT "sessions_expires_at_is_timestamp" CHECK(expires_at IS NULL OR (datetime(expires_at) IS NOT NULL AND substr(expires_at, 11, 1) = 'T' AND substr(expires_at, -1) = 'Z' AND length(expires_at) >= 20 AND date(expires_at) = substr(expires_at, 1, 10)))
) STRICT;--> statement-breakpoint
CREATE INDEX `sessions_user` ON `sessions` (`user_id`);
