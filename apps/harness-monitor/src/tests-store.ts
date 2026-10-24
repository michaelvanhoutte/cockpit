import type { Snapshot, TreeFacts } from './tests';

/**
 * The test explorer's snapshots, stored as the documents they arrive as
 * (migrations/0021_tests_snapshots.sql). A snapshot is written part by part
 * under its commit and is shown only once `tests_current` names it.
 *
 * Built to these failure modes:
 * - **Halfway**: each part is one statement. Parts sent before a stop are kept
 *   under their commit and never shown; the previous snapshot stays current,
 *   and the next switch that succeeds deletes them.
 * - **Twice**: a part replaces the one stored under its commit and area, so a
 *   re-send stores the snapshot once.
 * - **Rows that break the rule**: a part is checked whole before it is stored
 *   (src/tests.ts); an area the stored tree does not name is refused.
 * - **Interruption**: the switch and the deletion of every other commit's parts
 *   are one D1 batch, one transaction, so the old snapshot is shown until the
 *   new one is, and both are never left stored by a switch that landed.
 */

export type Stored = { ok: true } | { ok: false; status: number; error: string };

/** D1 hands a BLOB back as an array of bytes; the runtime may hand back an ArrayBuffer instead. */
const bytesOf = (value: unknown): Uint8Array => (value instanceof ArrayBuffer ? new Uint8Array(value) : Uint8Array.from(value as number[]));

/** Stores a tree under its commit, replacing one sent before, with the areas whose parts it waits for. */
export async function storeTree(db: D1Database, snapshot: Snapshot, tree: TreeFacts, document: Uint8Array, now = Date.now()): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tests_trees (snapshot, commit_sha, document, areas, received_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (snapshot, commit_sha) DO UPDATE SET document = excluded.document, areas = excluded.areas, received_at = excluded.received_at`,
    )
    .bind(snapshot, tree.commit, document, JSON.stringify(tree.areas), now)
    .run();
}

/**
 * Stores an area's source lines under its commit, replacing those sent before,
 * but only where that commit's tree is stored and names the area: in one
 * statement, so a tree deleted meanwhile leaves no part behind it.
 */
export async function storeArea(db: D1Database, snapshot: Snapshot, commit: string, area: string, document: Uint8Array, now = Date.now()): Promise<Stored> {
  const result = await db
    .prepare(
      `INSERT INTO tests_area_lines (snapshot, commit_sha, area, document, received_at)
       SELECT t.snapshot, t.commit_sha, ?3, ?4, ?5 FROM tests_trees t
       WHERE t.snapshot = ?1 AND t.commit_sha = ?2 AND EXISTS (SELECT 1 FROM json_each(t.areas) WHERE value = ?3)
       ON CONFLICT (snapshot, commit_sha, area) DO UPDATE SET document = excluded.document, received_at = excluded.received_at`,
    )
    .bind(snapshot, commit, area, document, now)
    .run();
  if (result.meta.changes > 0) return { ok: true };
  const tree = await db.prepare('SELECT 1 FROM tests_trees WHERE snapshot = ?1 AND commit_sha = ?2').bind(snapshot, commit).first();
  return tree
    ? { ok: false, status: 400, error: `The tree of ${commit} names no area ${JSON.stringify(area)}.` }
    : { ok: false, status: 409, error: `No tree of ${commit} is stored; send the tree first.` };
}

/** The parts a commit's snapshot is still waiting for: `the tree`, or each area not yet sent. */
async function missingParts(db: D1Database, snapshot: Snapshot, commit: string): Promise<string[]> {
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM tests_trees WHERE snapshot = ?1 AND commit_sha = ?2) AS trees,
              (SELECT json_group_array(a.value) FROM tests_trees t, json_each(t.areas) a
               WHERE t.snapshot = ?1 AND t.commit_sha = ?2
                 AND NOT EXISTS (SELECT 1 FROM tests_area_lines l WHERE l.snapshot = ?1 AND l.commit_sha = ?2 AND l.area = a.value)) AS areas`,
    )
    .bind(snapshot, commit)
    .first<{ trees: number; areas: string }>();
  if (!row?.trees) return ['the tree'];
  return (JSON.parse(row.areas) as string[]).map((area) => `area ${JSON.stringify(area)}`);
}

/** The refusal naming the parts a switch waited for. */
const stillMissing = (commit: string, missing: string[]): Stored => ({
  ok: false,
  status: 409,
  error: `${commit} cannot be made current until every part has arrived; missing ${missing.length === 1 ? '' : `${missing.length} parts: `}${missing.join(', ')}.`,
});

/**
 * Makes a commit's snapshot the one shown, once every part of it is stored, and
 * deletes every other commit's parts: the snapshot shown before and any left
 * unfinished. The switch is one statement guarded on every part being there,
 * and the deletions only follow a switch that landed, all in one batch, so a
 * part deleted by another switch meanwhile refuses this one rather than showing
 * a snapshot with a part missing.
 */
export async function makeCurrent(db: D1Database, snapshot: Snapshot, commit: string, now = Date.now()): Promise<Stored> {
  const missing = await missingParts(db, snapshot, commit);
  if (missing.length > 0) return stillMissing(commit, missing);
  const isCurrent = '(SELECT commit_sha FROM tests_current WHERE snapshot = ?1) = ?2';
  const [switched] = await db.batch([
    db
      .prepare(
        `INSERT INTO tests_current (snapshot, commit_sha, made_current_at)
         SELECT t.snapshot, t.commit_sha, ?3 FROM tests_trees t
         WHERE t.snapshot = ?1 AND t.commit_sha = ?2
           AND NOT EXISTS (SELECT 1 FROM json_each(t.areas) a
                           WHERE NOT EXISTS (SELECT 1 FROM tests_area_lines l WHERE l.snapshot = ?1 AND l.commit_sha = ?2 AND l.area = a.value))
         ON CONFLICT (snapshot) DO UPDATE SET commit_sha = excluded.commit_sha, made_current_at = excluded.made_current_at`,
      )
      .bind(snapshot, commit, now),
    db.prepare(`DELETE FROM tests_area_lines WHERE snapshot = ?1 AND commit_sha <> ?2 AND ${isCurrent}`).bind(snapshot, commit),
    db.prepare(`DELETE FROM tests_trees WHERE snapshot = ?1 AND commit_sha <> ?2 AND ${isCurrent}`).bind(snapshot, commit),
  ]);
  if (switched!.meta.changes > 0) return { ok: true };
  return stillMissing(commit, await missingParts(db, snapshot, commit));
}

/** The current snapshot's commit and its gzipped tree, or null when none has been made current. */
export async function currentTree(db: D1Database, snapshot: Snapshot): Promise<{ commit: string; document: Uint8Array } | null> {
  const row = await db
    .prepare(
      `SELECT c.commit_sha AS commit_sha, t.document AS document FROM tests_current c
       JOIN tests_trees t ON t.snapshot = c.snapshot AND t.commit_sha = c.commit_sha
       WHERE c.snapshot = ?1`,
    )
    .bind(snapshot)
    .first<{ commit_sha: string; document: unknown }>();
  return row ? { commit: row.commit_sha, document: bytesOf(row.document) } : null;
}
