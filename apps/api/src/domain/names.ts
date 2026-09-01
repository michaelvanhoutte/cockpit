/**
 * What a name is, for everything a person names: workspaces today, dashboards
 * as of "Add and switch dashboards" (issue 32), whatever comes next.
 *
 * It is its own module because the alternative is a second copy. Issue 32 says
 * in as many words not to reach for SQL's `lower()` when a second table needs
 * folding, "because copying it into a second table is how the same defect ships
 * twice" - and a second *application* fold, living beside the first, is the
 * same defect one step further along.
 */

/**
 * The name with its case folded away, which is what a unique index holds and
 * the only thing that decides whether two names are the same name ("Workspace
 * names are only case-insensitive in ASCII", issue 91).
 *
 * Upper-then-lower, not `toLowerCase()` alone, because lowercasing is not case
 * folding: `STRASSE` lowercases to `strasse` while `Straße` stays `straße`, so
 * the two would remain different names. Uppercasing expands `ß` to `SS` first,
 * and the pair folds together. Measured, not assumed - the case table in
 * apps/api/tests/unit/domain/names.test.ts is what pins it.
 *
 * Locale-independent on purpose: `toLocaleLowerCase()` would fold `I` by
 * whatever locale the Worker happens to run under, so the same two names could
 * be the same name in one deployment and not in another.
 *
 * What it deliberately does not do is normalize Unicode composition, so `é` as
 * one code point and `e` plus a combining accent still count as two names.
 * That is a real second way two names can look identical; it needs its own
 * decision about which normal form, and folding case is the half that bites.
 */
export function foldName(name: string): string {
  return name.trim().toUpperCase().toLowerCase();
}

/**
 * The one of `taken` already going by this name, or undefined.
 *
 * **One function, every writer.** Creating, renaming and adding are the places
 * a name is given, and they answer "is it taken?" here rather than each folding
 * and comparing for itself - which is what stops them drifting apart. The
 * unique index is the lock behind this, refusing what a race gets past.
 *
 * It folds the names on the way past rather than reading a stored `folded_name`,
 * because a row can hold a folded copy that is missing or stale: the code
 * serving requests during the deploy that introduced that column wrote none,
 * and the backfill that filled it could only fold the ASCII part of what it
 * found.
 *
 * `except` is the row doing the asking, and it is what makes renaming
 * `Personal` to `PERSONAL` work. The only row the new name folds onto is that
 * one itself, and a plain "is this name taken?" finds it and refuses a rename
 * that collides with nothing.
 *
 * What `taken` holds is the caller's scope, and it is the whole difference
 * between the two rules that use this: every live workspace of the account, or
 * every live dashboard of *one workspace*, so two workspaces may each have a
 * Research.
 */
export function namedTheSame<T extends { id: string; name: string }>(
  taken: readonly T[],
  name: string,
  except?: string,
): T | undefined {
  const folded = foldName(name);
  return taken.find((one) => one.id !== except && foldName(one.name) === folded);
}
