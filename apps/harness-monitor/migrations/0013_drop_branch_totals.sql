-- Contract: drops daily_branch_totals, which daily_split_totals (0009) replaced.
-- Nothing reads or writes it any more, and it is derived from usage_requests,
-- so no stored row is lost. Its unpriced index goes with the table.
DROP TABLE daily_branch_totals;
