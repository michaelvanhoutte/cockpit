-- The people already in the register are given an address, and no two users may
-- then share one ("Record the Google account each user signs in with", issue
-- 195). 0010 added the columns; this fills them and locks them.
--
-- **Its own file because every statement here can fail on the data it finds**,
-- and a file that fails is re-run whole by the next deploy. So each is written
-- to be run again: the backfills name their row by id and skip one that already
-- has an address, and the indexes are created only if absent. A duplicate that
-- stops this file is fixed by hand and the deploy retried, with 0010 already
-- recorded as applied and the old code still serving the old schema.
--
-- **The backfill runs before the indexes**, so an environment holding two users
-- with the same address stops the deploy rather than having one of them written
-- over. Staging is deliberately never re-seeded and production was seeded once
-- by hand (docs/deployment.md, "Bootstrap runbook"), so what both
-- hold is seed.sql's two people - but which environment holds what is exactly
-- the thing not to assume.
--
-- **The addresses are placeholders, and unusable on purpose.** The repository
-- is public, so no real address is in it; putting the real one on staging and
-- production is a step of "Sign in with Google, and retire the list of names",
-- issue 196, by hand. A row keeps whatever it already
-- has, so a real address set before this runs is not written over.
--
-- Users the register gained since seed.sql - there is no way to add one yet,
-- and "Add a user from the command line", issue 87, is where that arrives - are
-- named by neither UPDATE and are left
-- with no address, which is a row nobody can sign in as rather than a row that
-- lets the wrong person in.
UPDATE `users` SET `email` = 'michael@example.com' WHERE `id` = 'user-michael' AND `email` IS NULL;--> statement-breakpoint
UPDATE `users` SET `email` = 'ada@example.com' WHERE `id` = 'user-ada' AND `email` IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `users_email` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `users_google_subject` ON `users` (`google_subject`);
