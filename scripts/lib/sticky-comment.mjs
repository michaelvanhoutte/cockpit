//
// One comment per workflow per pull request, edited in place rather than
// re-posted.
//
// Extracted when two workflows needed it and were about to fight over the same
// comment. The preview deploy used `gh pr comment --edit-last`, which matches
// the most recent comment by the current author and nothing else, and the
// security review's gate began posting under that same identity - so whichever
// spoke last became the other's next edit target: the verdict overwritten by a
// preview URL, or a fresh verdict posted and overwritten again. Neither
// workflow was wrong on its own; the collision only existed once both were
// talking.
//
// **The preview deploy has since been removed** (docs/deployment.md, "No branch
// environments"), so the gate is the only caller today. The marker still earns
// its place: `--edit-last` would claim *any* most-recent comment by that bot,
// and the same bot leaves others. Being addressed by name rather than by "who
// spoke last" is what makes a second caller safe to add, which is the property
// that was missing before.
//
// A marker per workflow is what makes callers ignore each other, and the author
// check is what stops anyone else claiming either - see markedCommentId.
//
// `gh` is a parameter rather than an import for the same reason stopPlan() in
// processes.mjs takes the platform: a function that reaches for its own
// subprocess can only be tested by running one.
//

import { markedCommentId } from './review-gate.mjs';

/**
 * Post `body` under `marker`, or edit the note already there.
 *
 * Returns what it did, so a caller can log it - a silent success and a silent
 * no-op look identical in a run log otherwise.
 */
export function upsertSticky({ gh, repo, pr, marker, body }) {
  const listed = gh([
    'api',
    `repos/${repo}/issues/${pr}/comments`,
    '--paginate',
    // The author travels with the id and body because matching on the marker
    // alone lets anyone who can comment claim the note.
    '--jq',
    '.[] | {id, body, login: .user.login} | @json',
  ]);

  const existingId = markedCommentId(listed, { marker });
  const payload = JSON.stringify({ body: `${marker}\n${body}` });

  if (existingId !== null) {
    gh(['api', '--method', 'PATCH', `repos/${repo}/issues/comments/${existingId}`, '--input', '-'], payload);
    return { action: 'edited', id: existingId };
  }
  gh(['api', '--method', 'POST', `repos/${repo}/issues/${pr}/comments`, '--input', '-'], payload);
  return { action: 'posted', id: null };
}
