CREATE TABLE `associations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`item_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `associations_tenant_item` ON `associations` (`tenant_id`,`item_id`);--> statement-breakpoint
CREATE TABLE `commands` (
	`command_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`payload` text NOT NULL,
	`issued_at` text NOT NULL,
	`received_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `commands_tenant_received` ON `commands` (`tenant_id`,`received_at`);--> statement-breakpoint
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
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `items_tenant_workspace_status` ON `items` (`tenant_id`,`workspace_id`,`status`);--> statement-breakpoint
CREATE TABLE `tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`color` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_tenant_slug` ON `workspaces` (`tenant_id`,`slug`);