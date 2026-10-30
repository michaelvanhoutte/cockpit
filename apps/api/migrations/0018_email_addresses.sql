-- Which account an Email to Cockpit address belongs to ("Get an Email to
-- Cockpit address, and receive mail at it", issue 1466).
--
-- **A new table, so nothing existing is touched**: it starts empty in every
-- environment, since no account has an address before this release. A row is
-- written when somebody presses *Get an address*.
--
-- **Pure DDL in one file**, so a failure leaves no table and the migrator runs
-- the file again on the next deploy; once applied it is recorded and skipped.
--
-- **STRICT by hand**, drizzle-kit being unable to emit it, and the CHECK
-- holding `held_at` to an instant is the one every timestamp column here
-- carries. Written by hand, since drizzle-kit asks interactively whether the
-- four old tables it would drop were renamed to this one - they were not, and
-- are deliberately not dropped, the same as 0012 to 0017.
CREATE TABLE `email_addresses` (
	`local_part` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`held_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "email_addresses_held_at_is_timestamp" CHECK(held_at IS NULL OR (datetime(held_at) IS NOT NULL AND substr(held_at, 11, 1) = 'T' AND substr(held_at, -1) = 'Z' AND length(held_at) >= 20 AND date(held_at) = substr(held_at, 1, 10)))
) STRICT;
--> statement-breakpoint
CREATE INDEX `email_addresses_account` ON `email_addresses` (`account_id`);
