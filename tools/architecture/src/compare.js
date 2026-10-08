/**
 * What changed since the last report: reads the previous report's model for the
 * commit it names, draws that commit with today's generator and diffs the two
 * models. The previous model's own content is never compared (a change to the
 * generator alone would show as a change to Cockpit); only its commit is used,
 * so a missed night loses nothing, the comparison being against what was last
 * published however long ago.
 *
 * Every outcome but a comparison is "nothing to compare": the page says which,
 * lists nothing, and the run goes on.
 */

import { buildModel } from './model.js';
import { atCommit, hasCommit, readCheckout, readPreviousModel } from './read.js';
import { diffModels } from './diff.js';

/**
 * @param {{ root: string, model: object, description: { file: string, text: string }, previous: string|null, fetchImpl?: typeof fetch }} input
 *   `model` is the model of the checkout being drawn; `description` its description file, for a commit that has none.
 * @returns {Promise<{ state: 'compared', from: object, to: object, changes: object[], descriptionFromElsewhere: boolean } | { state: 'first' } | { state: 'unavailable', reason: string }>}
 */
export async function compareWithPrevious({ root, model, description, previous, fetchImpl }) {
  if (!previous) return { state: 'unavailable', reason: 'no earlier report was given to compare against' };
  const read = await readPreviousModel(previous, { fetchImpl });
  if (read.first) return { state: 'first' };
  if (read.unreadable) return { state: 'unavailable', reason: read.unreadable };

  const commit = read.model.drawnFrom.commit;
  if (!hasCommit(root, commit)) return { state: 'unavailable', reason: `the previous report was drawn from ${commit.slice(0, 7)}, which is not in this checkout's history` };

  let drawn;
  try {
    drawn = await atCommit(root, commit, (folder) => {
      const checkout = readCheckout(folder, { commit, fallbackDescription: description });
      return { model: buildModel(checkout), descriptionFromElsewhere: checkout.descriptionFromElsewhere };
    });
  } catch (error) {
    // Whatever went wrong drawing the earlier commit costs this section and never the night.
    return { state: 'unavailable', reason: `${commit.slice(0, 7)} could not be drawn: ${error.message}` };
  }
  return {
    state: 'compared',
    from: drawn.model.drawnFrom,
    to: model.drawnFrom,
    changes: diffModels(drawn.model, model),
    descriptionFromElsewhere: drawn.descriptionFromElsewhere,
  };
}
