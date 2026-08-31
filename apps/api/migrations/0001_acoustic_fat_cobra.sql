-- Constraints: STRICT tables, CHECK on every closed set, and foreign keys.
--
-- Hand-written, not the drizzle-kit output. Two reasons, both worth knowing
-- before regenerating this file:
--
-- 1. drizzle-kit cannot emit STRICT. It is not in drizzle-orm's sqlite-core
--    table API and the kit never writes the keyword, so every migration
--    carries it by hand. See the note in src/db/schema.ts.
-- 2. The generated rebuild was ordered alphabetically: it recreated
--    `associations` and `items` with foreign keys onto `tenants`, then dropped
--    and recreated `tenants` underneath them, having re-enabled
--    PRAGMA foreign_keys partway through.
--
-- **Data is preserved.** Staging is deliberately never re-seeded - accumulated
-- state is the whole reason it exists - and production is seeded only once, as
-- a manual bootstrap. A drop-and-recreate would therefore leave both with no
-- tenant and no workspaces, and the new foreign keys would then reject every
-- write. It would also break the rule in docs/deployment.md ("Migrations and
-- rollback"): migrations must be expand-then-contract, never destructive in a
-- single release, because promoting an earlier commit rolls code back without
-- rolling the schema back.
--
-- Tightening constraints in place is compatible with the old code in that
-- window, with one narrow exception: the old code accepted a capture naming a
-- workspace that does not exist, and the new foreign key refuses it. That
-- request was writing an orphan row before, so nothing that was previously
-- correct starts failing.
--
-- Shape: copy each table aside, rebuild it with its constraints, copy back.
-- The copies carry no constraints of their own, so this needs no PRAGMA and
-- no reliance on foreign-key enforcement being toggleable on D1.

CREATE TABLE `_migrate_tenants` AS SELECT * FROM `tenants`;--> statement-breakpoint
CREATE TABLE `_migrate_workspaces` AS SELECT * FROM `workspaces`;--> statement-breakpoint
CREATE TABLE `_migrate_items` AS SELECT * FROM `items`;--> statement-breakpoint
CREATE TABLE `_migrate_associations` AS SELECT * FROM `associations`;--> statement-breakpoint
CREATE TABLE `_migrate_commands` AS SELECT * FROM `commands`;--> statement-breakpoint

-- Dropped child-first, so no foreign key is dangling at any point.
DROP TABLE `associations`;--> statement-breakpoint
DROP TABLE `items`;--> statement-breakpoint
DROP TABLE `commands`;--> statement-breakpoint
DROP TABLE `workspaces`;--> statement-breakpoint
DROP TABLE `tenants`;--> statement-breakpoint

CREATE TABLE `tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "tenants_created_at_is_timestamp" CHECK(created_at IS NULL OR (datetime(created_at) IS NOT NULL AND substr(created_at, 11, 1) = 'T' AND length(created_at) >= 20))
) STRICT;
--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`color` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "workspaces_created_at_is_timestamp" CHECK(created_at IS NULL OR (datetime(created_at) IS NOT NULL AND substr(created_at, 11, 1) = 'T' AND length(created_at) >= 20))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_tenant_slug` ON `workspaces` (`tenant_id`,`slug`);--> statement-breakpoint

CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`source` text NOT NULL,
	`source_id` text,
	`source_link` text,
	`sender` text,
	`source_timestamp` text,
	`title` text NOT NULL,
	`preview` text,
	`source_resolved_at` text,
	`status` text NOT NULL,
	`next_action` text,
	`focus_horizon` text,
	`priority` text,
	`due_date` text,
	`snoozed_until` text,
	`unseen` integer DEFAULT false NOT NULL,
	`deleted_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "items_source_is_known" CHECK(source IN ('internal', 'mail', 'slack', 'notion', 'whatsapp')),
	CONSTRAINT "items_status_is_known" CHECK(status IN ('to_process', 'task', 'waiting', 'snoozed', 'delegated', 'reference', 'done', 'dismissed')),
	CONSTRAINT "items_focus_horizon_is_known" CHECK(focus_horizon IN ('today', 'week', 'month', 'quarter')),
	CONSTRAINT "items_priority_is_known" CHECK(priority IN ('low', 'normal', 'high')),
	CONSTRAINT "items_unseen_is_flag" CHECK(unseen IN (0, 1)),
	CONSTRAINT "items_due_date_is_date" CHECK(due_date IS NULL OR (date(due_date) IS NOT NULL AND date(due_date) = due_date)),
	CONSTRAINT "items_source_timestamp_is_timestamp" CHECK(source_timestamp IS NULL OR (datetime(source_timestamp) IS NOT NULL AND substr(source_timestamp, 11, 1) = 'T' AND length(source_timestamp) >= 20)),
	CONSTRAINT "items_source_resolved_at_is_timestamp" CHECK(source_resolved_at IS NULL OR (datetime(source_resolved_at) IS NOT NULL AND substr(source_resolved_at, 11, 1) = 'T' AND length(source_resolved_at) >= 20)),
	CONSTRAINT "items_snoozed_until_is_timestamp" CHECK(snoozed_until IS NULL OR (datetime(snoozed_until) IS NOT NULL AND substr(snoozed_until, 11, 1) = 'T' AND length(snoozed_until) >= 20)),
	CONSTRAINT "items_deleted_at_is_timestamp" CHECK(deleted_at IS NULL OR (datetime(deleted_at) IS NOT NULL AND substr(deleted_at, 11, 1) = 'T' AND length(deleted_at) >= 20)),
	CONSTRAINT "items_created_at_is_timestamp" CHECK(created_at IS NULL OR (datetime(created_at) IS NOT NULL AND substr(created_at, 11, 1) = 'T' AND length(created_at) >= 20)),
	CONSTRAINT "items_updated_at_is_timestamp" CHECK(updated_at IS NULL OR (datetime(updated_at) IS NOT NULL AND substr(updated_at, 11, 1) = 'T' AND length(updated_at) >= 20))
) STRICT;
--> statement-breakpoint
CREATE INDEX `items_tenant_workspace_status` ON `items` (`tenant_id`,`workspace_id`,`status`);--> statement-breakpoint

CREATE TABLE `associations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`item_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "associations_kind_is_known" CHECK(kind IN ('person', 'project', 'topic')),
	CONSTRAINT "associations_created_at_is_timestamp" CHECK(created_at IS NULL OR (datetime(created_at) IS NOT NULL AND substr(created_at, 11, 1) = 'T' AND length(created_at) >= 20))
) STRICT;
--> statement-breakpoint
CREATE INDEX `associations_tenant_item` ON `associations` (`tenant_id`,`item_id`);--> statement-breakpoint

CREATE TABLE `commands` (
	`command_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`payload` text NOT NULL,
	`issued_at` text NOT NULL,
	`received_at` text NOT NULL,
	CONSTRAINT "commands_payload_is_json" CHECK(json_valid(payload)),
	CONSTRAINT "commands_issued_at_is_timestamp" CHECK(issued_at IS NULL OR (datetime(issued_at) IS NOT NULL AND substr(issued_at, 11, 1) = 'T' AND length(issued_at) >= 20)),
	CONSTRAINT "commands_received_at_is_timestamp" CHECK(received_at IS NULL OR (datetime(received_at) IS NOT NULL AND substr(received_at, 11, 1) = 'T' AND length(received_at) >= 20))
) STRICT;
--> statement-breakpoint
CREATE INDEX `commands_tenant_received` ON `commands` (`tenant_id`,`received_at`);--> statement-breakpoint

-- Restored parent-first. Columns are named rather than `SELECT *` so a future
-- column reorder cannot silently shift values into the wrong columns.
--
-- The WHERE clauses drop rows whose parent is missing. Those are exactly the
-- orphans the new foreign keys declare impossible, so there is nowhere to put
-- them; every other row carries over. Anything violating a CHECK instead fails
-- the migration loudly, which is correct - the write path validated all of it
-- on the way in, so a violation means an assumption is wrong.
INSERT INTO `tenants` (`id`, `name`, `created_at`)
	SELECT `id`, `name`, `created_at` FROM `_migrate_tenants`;--> statement-breakpoint
INSERT INTO `workspaces` (`id`, `tenant_id`, `name`, `slug`, `color`, `created_at`)
	SELECT `id`, `tenant_id`, `name`, `slug`, `color`, `created_at` FROM `_migrate_workspaces`
	WHERE `tenant_id` IN (SELECT `id` FROM `tenants`);--> statement-breakpoint
INSERT INTO `items` (`id`, `tenant_id`, `workspace_id`, `source`, `source_id`, `source_link`, `sender`, `source_timestamp`, `title`, `preview`, `source_resolved_at`, `status`, `next_action`, `focus_horizon`, `priority`, `due_date`, `snoozed_until`, `unseen`, `deleted_at`, `created_at`, `updated_at`)
	SELECT `id`, `tenant_id`, `workspace_id`, `source`, `source_id`, `source_link`, `sender`, `source_timestamp`, `title`, `preview`, `source_resolved_at`, `status`, `next_action`, `focus_horizon`, `priority`, `due_date`, `snoozed_until`, `unseen`, `deleted_at`, `created_at`, `updated_at` FROM `_migrate_items`
	WHERE `tenant_id` IN (SELECT `id` FROM `tenants`)
	  AND `workspace_id` IN (SELECT `id` FROM `workspaces`);--> statement-breakpoint
INSERT INTO `associations` (`id`, `tenant_id`, `item_id`, `kind`, `label`, `created_at`)
	SELECT `id`, `tenant_id`, `item_id`, `kind`, `label`, `created_at` FROM `_migrate_associations`
	WHERE `tenant_id` IN (SELECT `id` FROM `tenants`)
	  AND `item_id` IN (SELECT `id` FROM `items`);--> statement-breakpoint
INSERT INTO `commands` (`command_id`, `tenant_id`, `workspace_id`, `name`, `payload`, `issued_at`, `received_at`)
	SELECT `command_id`, `tenant_id`, `workspace_id`, `name`, `payload`, `issued_at`, `received_at` FROM `_migrate_commands`;--> statement-breakpoint

DROP TABLE `_migrate_tenants`;--> statement-breakpoint
DROP TABLE `_migrate_workspaces`;--> statement-breakpoint
DROP TABLE `_migrate_items`;--> statement-breakpoint
DROP TABLE `_migrate_associations`;--> statement-breakpoint
DROP TABLE `_migrate_commands`;
