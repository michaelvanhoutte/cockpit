-- The register gains the index that says which account and Workspace a source's
-- own name for somebody points at ("Save a Teams message to Cockpit", issue
-- 486). One inbound address receives a saved message for every connected
-- account at once, and a Worker cannot join a Durable Object to anything - so
-- the question "whose is this?" is asked here, before any account is known, and
-- confirmed against that account's own store before anything is written.
--
-- **A new table, so there is no half of it and nothing to back-fill**: it starts
-- empty, and a connection made from this release forward writes its row as it
-- is made. A connection made before it simply never receives a push until it is
-- connected again, which is one press.
--
-- **STRICT by hand**, drizzle-kit being unable to emit it, and the CHECK holding
-- `connected_at` to an instant is the one every timestamp column here carries.
--
-- **The four tables an account's data used to live in are deliberately not
-- dropped**, though drizzle-kit emits exactly that when this is regenerated -
-- the same as 0012 and 0013.
CREATE TABLE `connector_directory` (
	`connector_id` text NOT NULL,
	`external_account_key` text NOT NULL,
	`account_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`connected_at` text NOT NULL,
	PRIMARY KEY(`connector_id`, `external_account_key`, `account_id`, `workspace_id`),
	FOREIGN KEY (`account_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "connector_directory_connected_at_is_timestamp" CHECK(connected_at IS NULL OR (datetime(connected_at) IS NOT NULL AND substr(connected_at, 11, 1) = 'T' AND substr(connected_at, -1) = 'Z' AND length(connected_at) >= 20 AND date(connected_at) = substr(connected_at, 1, 10)))
) STRICT;
--> statement-breakpoint
CREATE INDEX `connector_directory_account_at_source` ON `connector_directory` (`connector_id`,`external_account_key`,`connected_at`);
