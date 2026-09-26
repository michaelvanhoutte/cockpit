//
// What stands in for the merge-base with `main` on a pull request, shared by the
// two jobs that select what to run from a diff (scripts/ci-test.mjs and
// scripts/ci-e2e.mjs).
//
// Read off HEAD itself rather than fetched or computed with `git merge-base`:
// the default checkout for a pull_request event is GitHub's own merge of the PR
// against its base (refs/pull/<n>/merge), kept current with `main` as `main`
// moves, so HEAD's first parent is the base commit that merge was computed
// against. A textbook `git merge-base` would return the PR branch's own fork
// point, inflating "changed" by everything `main` gained since the PR forked.
// Reproducing a selection by hand: diff against this parent.
//
// Any git command failing yields both empty - which both callers treat as "run
// everything", as they do for an event that isn't a pull request: a diff that
// can't be read must never read as "nothing changed".
//

/**
 * @param {string} event `GITHUB_EVENT_NAME`
 * @param {(args: string[]) => string} git trimmed stdout of `git args...`, throwing on failure
 * @param {(message: string) => void} warn
 * @returns {{ mergeBase: string | null, changedFiles: string[] }}
 */
export function placeMergeBase(event, git, warn) {
  if (event !== 'pull_request') return { mergeBase: null, changedFiles: [] };
  try {
    // Oldest-parent-first: `[base, head]` for the synthetic merge commit a
    // pull_request event checks out, `[parent]` for an ordinary commit.
    const parents = git(['rev-list', '--parents', '-n', '1', 'HEAD']).split(/\s+/).slice(1);
    if (parents.length !== 2) return { mergeBase: null, changedFiles: [] };
    const mergeBase = parents[0];
    const changedFiles = git(['diff', '--name-only', mergeBase, 'HEAD']).split('\n').filter(Boolean);
    return { mergeBase, changedFiles };
  } catch (error) {
    warn(`Could not place a merge-base (${error.message}); running everything in full.`);
    return { mergeBase: null, changedFiles: [] };
  }
}
