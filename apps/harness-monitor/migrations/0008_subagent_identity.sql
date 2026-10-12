-- Expand-only: adds two nullable columns, changes no row. A subagent's request
-- names the kind of subagent and which one it was; the task it was given is
-- never sent or stored. Rows from before, and every main-agent request, hold NULL.
ALTER TABLE usage_requests ADD COLUMN subagent_type TEXT;
ALTER TABLE usage_requests ADD COLUMN subagent_id TEXT;
