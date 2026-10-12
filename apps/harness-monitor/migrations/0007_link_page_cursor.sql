-- Expand-only: adds a column, changes no row. page_cursor is GitHub's own place
-- in the repository's pull requests, ordered by update time, where the next
-- linking run starts; null reads from the first. It supersedes link_state.cursor, the
-- newest update time read, which nothing writes any more and a contract
-- migration can drop once no deployed code reads it.
ALTER TABLE link_state ADD COLUMN page_cursor TEXT;
