-- One row per attempt at a paid provider call ("Record every Claude call
-- Cockpit makes, and keep the record for 12 months", issue 917).
--
-- **A new table, so nothing existing is touched**: it starts empty in every
-- environment, and rows are written from this release forward.
--
-- **No foreign key to `users` or `tenants`**, so a row outlives the user it
-- names and deleting somebody never has to clear it first.
--
-- **STRICT by hand**, drizzle-kit being unable to emit it. Written by hand
-- too, since drizzle-kit asks interactively whether the four old tables it
-- would drop were renamed to this one - they were not, and are deliberately
-- not dropped, the same as 0012 to 0015.
CREATE TABLE `provider_calls` (
	`id` integer PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`operation` text NOT NULL,
	`prompt_version` text,
	`triggered_by` text,
	`account_name` text,
	`user_id` text,
	`item_id` text,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`paid_by` text NOT NULL,
	`paid_by_account` text,
	`paid_by_key_ending` text,
	`outcome` text NOT NULL,
	`status` integer,
	`duration_ms` integer NOT NULL,
	`tokens_in` integer,
	`cache_read` integer,
	`cache_write` integer,
	`tokens_out` integer,
	CONSTRAINT "provider_calls_at_is_timestamp" CHECK(at IS NULL OR (datetime(at) IS NOT NULL AND substr(at, 11, 1) = 'T' AND substr(at, -1) = 'Z' AND length(at) >= 20 AND date(at) = substr(at, 1, 10))),
	CONSTRAINT "provider_calls_outcome_is_known" CHECK(outcome IN ('ok', 'error', 'timed-out'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `provider_calls_at` ON `provider_calls` (`at`);
