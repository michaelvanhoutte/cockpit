-- One row per deliberate sign-in, with what a guest did in it ("Record every
-- sign-in, with guest activity, for 12 months", issue 653).
--
-- **A new table, so nothing existing is touched**: it starts empty, and rows
-- are written from this release forward. Sign-ins before it are not
-- reconstructed; `users.last_signed_in_at` still holds each person's latest.
--
-- **STRICT by hand**, drizzle-kit being unable to emit it, and the CHECK
-- holding `at` to an instant is the one every timestamp column here carries.
--
-- **The four tables an account's data used to live in are deliberately not
-- dropped**, though drizzle-kit emits exactly that when this is regenerated -
-- the same as 0012 to 0014.
CREATE TABLE `sign_ins` (
	`session_id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`at` text NOT NULL,
	`country` text,
	`referrer_host` text,
	`items_captured` integer DEFAULT 0 NOT NULL,
	`dashboards_opened` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sign_ins_at_is_timestamp" CHECK(at IS NULL OR (datetime(at) IS NOT NULL AND substr(at, 11, 1) = 'T' AND substr(at, -1) = 'Z' AND length(at) >= 20 AND date(at) = substr(at, 1, 10)))
) STRICT;
--> statement-breakpoint
CREATE INDEX `sign_ins_at` ON `sign_ins` (`at`);--> statement-breakpoint
CREATE INDEX `sign_ins_user` ON `sign_ins` (`user_id`);
