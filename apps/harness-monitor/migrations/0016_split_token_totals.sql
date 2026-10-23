-- Expand-only: adds four columns at zero, changes no row. Every request's
-- tokens, priced or not, on the split totals, so the costs page can count each
-- day's tokens under the same filters as its dollars. Updated in the batch that
-- stores the rows and rebuilt nightly from them, as the dollars are. Rows stored
-- before this read zero tokens until the rebuild runs, by hand once the deploy
-- lands (`pnpm harness:run rebuild`); filling them here would restate the
-- rebuild's Belgian-day rule. Code that predates it ignores the columns, so
-- rolling back needs no restore.
ALTER TABLE daily_split_totals ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_split_totals ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_split_totals ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_split_totals ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
