/**
 * The What changed section: a table of change, where and flag, naming both
 * commits compared, or a sentence saying why there is nothing to compare.
 */

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const TONES = { call: 'p-hand', plain: 'p-mech' };

const commitLink = ({ commit, repo }) =>
  repo ? `<a href="${esc(`https://github.com/${repo}/commit/${commit}`)}" target="_blank" rel="noopener"><b>${esc(commit.slice(0, 7))}</b></a>` : `<b>${esc(commit.slice(0, 7))}</b>`;
const commitDay = ({ date }) => (date ? ` (${esc(date.slice(0, 10))})` : '');

/** The sentence that says nothing was compared, and why. */
export function nothingToCompare(comparison) {
  if (comparison.state === 'first') return 'This is the first report, so there is nothing to compare it with.';
  return `There is nothing to compare: ${comparison.reason}.`;
}

export function renderChanges(comparison) {
  if (comparison.state !== 'compared') return `<p class="sectionnote">${esc(nothingToCompare(comparison))}</p>`;

  const { from, to, changes, descriptionFromElsewhere } = comparison;
  const compared = `<p class="sectionnote">Since the commit the live report was drawn from, ${commitLink(from)}${commitDay(from)}, to ${commitLink(to)}${commitDay(to)}. Both are drawn by this generator, so a change to the generator alone is not listed.${descriptionFromElsewhere ? ' The earlier commit has no description file, so it is drawn with this one\u2019s.' : ''}</p>`;
  if (changes.length === 0) return `${compared}\n  <p class="sectionnote"><b>Nothing changed.</b></p>`;

  const rows = changes
    .map(
      (each) =>
        `<tr><td>${esc(each.text)}</td><td>${each.where.map((where) => `<code>${esc(where)}</code>`).join(', ')}</td><td><span class="pill ${TONES[each.flag.tone] ?? 'p-mech'}">${esc(each.flag.label)}</span></td></tr>`,
    )
    .join('\n        ');
  return `${compared}
  <div class="scroll"><table class="changes">
    <thead><tr><th>Change</th><th>Where</th><th>Flag</th></tr></thead>
    <tbody>
        ${rows}
    </tbody>
  </table></div>`;
}
