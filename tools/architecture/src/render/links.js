/**
 * Links to the code on GitHub, shared by the pages that open it. Every link opens the code at the commit the
 * page was drawn from, so a line number still means what it did; without a repository and a commit there are none.
 */

import { esc } from './svg.js';

/** Links to the code on GitHub: `null` for each when the page does not know its repository and commit. */
export function linksFor({ repo, commit }) {
  const known = Boolean(repo && commit);
  /** @param {string} rel @param {{ line?: number|null, folder?: boolean }} [at] */
  const url = (rel, { line = null, folder = false } = {}) => (known ? `https://github.com/${repo}/${folder ? 'tree' : 'blob'}/${commit}/${rel.replace(/\/$/, '')}${line ? `#L${line}` : ''}` : null);
  const file = (rel, line) => {
    const href = url(rel, { line });
    const label = `<code>${esc(rel)}${line ? `:${line}` : ''}</code>`;
    return href ? `<a class="gh" href="${esc(href)}" target="_blank" rel="noopener">${label}</a>` : label;
  };
  const files = (list, at = {}, separator = '<br>') => list.map((each) => file(each, at[each])).join(separator);
  return { known, url, file, files };
}

/** The line under a page's heading that names the commit it was drawn from, and says what its links open. */
export function commitLineOf(drawnFrom, links) {
  const { commit, repo } = drawnFrom;
  if (!commit) return '<span>commit <b>not known</b>, so no link to the code opens</span>';
  if (!links.known) return `<span>commit <b>${esc(commit.slice(0, 7))}</b>, which no link opens the code at here: the repository is not known</span>`;
  return `<span>commit <a class="gh" href="${esc(`https://github.com/${repo}/tree/${commit}`)}" target="_blank" rel="noopener"><b>${esc(commit.slice(0, 7))}</b></a>, which every ↗ link opens the code at</span>`;
}
