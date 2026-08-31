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
-- Existing rows are dropped rather than copied, which is what lets this be a
-- plain drop-and-recreate instead of the twelve-step rebuild. The local and
-- preview databases are rebuilt from seed.sql on every run; staging and
-- production are re-seeded the same way.
--
-- Dropped child-first and created parent-first, so no foreign key is ever
-- dangling and this needs no PRAGMA to get through.

DROP TABLE IF EXISTS `associations`;--> statement-breakpoint
DROP TABLE IF EXISTS `items`;--> statement-breakpoint
DROP TABLE IF EXISTS `commands`;--> statement-breakpoint
DROP TABLE IF EXISTS `workspaces`;--> statement-breakpoint
DROP TABLE IF EXISTS `tenants`;--> statement-breakpoint

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
CREATE INDEX `commands_tenant_received` ON `commands` (`tenant_id`,`received_at`);
