/**
 * How much one statement can carry, and how to split a write that exceeds it.
 *
 * A store's SQLite binds at most 100 values per statement (architecture, "No
 * statement's parameter count grows with the data"), so a multi-row insert
 * holding one row per thing the user has works until they have enough and then
 * fails - as a 500 on a change the screen depends on, not as a slow query.
 *
 * The arithmetic lives here once because it was got wrong three times: a
 * dashboard could not be rearranged past sixteen panels, a workspace stopped
 * painting past ninety-nine layouts, and a panel refused a twenty-first item.
 * A fourth table would otherwise copy the sum a fourth time and pick its own
 * number.
 */
export const BOUND_VALUES_PER_STATEMENT = 100;

/**
 * One insert's worth of rows at a time, for a row of `valuesPerRow` columns.
 *
 * Order is kept across the split and every row lands in exactly one batch, so
 * what is written is what was passed in - the split is a property of the
 * statement, not of the thing being written. Any `position` a row carries is
 * already on it by the time this is called, so a row's place survives being in
 * the second batch.
 *
 * The batches must be sent inside one transaction. That is what keeps a write
 * all-or-nothing: a batch failing with its predecessors already committed would
 * leave a half-written arrangement or a half-filed panel, and nothing
 * afterwards would know to finish it.
 */
export function inBatchesOf<T>(rows: readonly T[], valuesPerRow: number): T[][] {
  const size = Math.floor(BOUND_VALUES_PER_STATEMENT / valuesPerRow);
  if (size < 1) throw new Error(`a row of ${valuesPerRow} values cannot be written at all`);
  const batches: T[][] = [];
  for (let from = 0; from < rows.length; from += size) {
    batches.push(rows.slice(from, from + size));
  }
  return batches;
}
