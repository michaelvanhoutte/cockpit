-- Each record of a paid provider call gains the environment that made it and
-- what it cost ("Price every Claude call production records, and name its
-- environment", issue 1457), and somewhere to say where a CI or local call was
-- made: the pull request and run, or the branch.
--
-- **Expand only: every row already there is kept exactly as it is.** Each was
-- written by the environment whose table holds it, so the default makes
-- production's own rows read as production, which is true of every one; the
-- cost and the place stay blank. Nothing is back-filled - a cost is worked out
-- only as a row is written, never recomputed.
--
-- **Pure DDL that reads no row, so a failure leaves the table as it was or
-- with the columns added**, and the migrator applies the file once. Not re-runnable once it has succeeded, for the reason 0012 gives:
-- SQLite has no ADD COLUMN IF NOT EXISTS.
--
-- **No CHECK on the environment**, though it has four values: adding one to a
-- table that exists rebuilds it in SQLite, the manoeuvre 0012 explains.
--
-- **The four tables an account's data used to live in are deliberately not
-- dropped**, though drizzle-kit emits exactly that when this is regenerated -
-- it did here, and the DROPs were taken back out, the same as 0012 to 0016.
ALTER TABLE `provider_calls` ADD `environment` text DEFAULT 'production' NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_calls` ADD `cost_usd` real;--> statement-breakpoint
ALTER TABLE `provider_calls` ADD `pull_request` integer;--> statement-breakpoint
ALTER TABLE `provider_calls` ADD `run_id` integer;--> statement-breakpoint
ALTER TABLE `provider_calls` ADD `branch` text;
