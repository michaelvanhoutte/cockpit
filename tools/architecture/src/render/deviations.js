/**
 * What a deviation opens on the Logical page: the table of deviations accepted with a reason, and the dialog every
 * red and ✓ circle and every row's button open, holding what the deviation breaks, its files linked to their lines
 * and a `/scoping` prompt to copy. The prompts are built here, with the page, and carried in it as data: copying
 * runs in the browser and sends nothing.
 */

import { esc } from './svg.js';

/** A reason as a sentence body: one full stop is added by the caller, so none the text already ends in is kept. */
const bare = (text) => String(text).replace(/[.\s]+$/, '');

/** The prompt a deviation copies: the deviation in the design's words, the rule it breaks and the exact lines, so a fresh session can scope the fix without opening the page. */
export function devPrompt(e, { logical, nameOf, layerById, links, commit }) {
  const allowed = logical.mayCall.filter(([a]) => a === e.a).map(([, b]) => layerById.get(b).title);
  const where = e.files.map((file) => {
    const href = links.url(file, { line: e.at[file] });
    return `- ${file}${e.at[file] ? `:${e.at[file]}` : ''}${href ? ` (${href})` : ''}`;
  }).join('\n');
  const head = e.accepted
    ? `/scoping Reconsider an accepted architecture deviation in Cockpit.\n\nIt is accepted today because: ${e.accepted.reason}`
    : '/scoping Fix an architecture deviation in Cockpit.';
  const earlier = e.partly ? `\nAn earlier acceptance covers ${e.partly.files.join(', ')} ("${e.partly.reason}"); ${e.newFiles.join(', ')} ${e.newFiles.length === 1 ? 'is' : 'are'} new.` : '';
  return `${head}

${nameOf(e.from)} (${layerById.get(e.a).title}) reaches ${nameOf(e.to)} (${layerById.get(e.b).title}). ${bare(e.why)}.
The design lets ${layerById.get(e.a).title} call only: ${allowed.join(', ') || 'nothing'}.${earlier}

Where the code does it${commit ? `, at commit ${commit.slice(0, 7)}` : ''}:
${where}

Decide whether to change the code so it follows the design, or to keep it and accept the deviation with a written reason.`;
}

/** Every deviation on a page, by the id its circle and its row's button carry. */
export function devData(context) {
  const { logical, nameOf, links } = context;
  return Object.fromEntries([...logical.bad, ...logical.accepted].map((e) => [e.id, {
    title: `${e.accepted ? 'Accepted' : `Deviation ${e.n}`}: ${nameOf(e.from)} → ${nameOf(e.to)}`,
    why: e.accepted ? `${bare(e.why)}. Accepted: ${e.accepted.reason}` : e.why,
    files: links.files(e.files, e.at),
    prompt: devPrompt(e, context),
  }]));
}

/** Deviations accepted with a reason: grey on the diagram, and an acceptance nothing needs any more. */
export function accTable(logical, { nameOf }, links) {
  const rows = logical.accepted.map((e, i) => `<tr id="acc-${i + 1}"><td><span class="num num-acc">✓</span></td><td>${esc(nameOf(e.from))}</td><td>${esc(nameOf(e.to))}</td><td>${esc(e.accepted.reason)}</td><td>${links.files(e.files, e.at)}</td><td><button class="copy" data-dev="${e.id}">Reconsider</button></td></tr>`);
  const stale = logical.stale.map((x) => `<tr><td></td><td>${esc(nameOf(x.from))}</td><td>${esc(nameOf(x.to))}</td><td><span class="bad">No longer needed:</span> no file it names makes this line any more. Remove the acceptance, or update its files if the line is still red above.<br><span class="dim">${esc(x.reason)}</span></td><td>${x.files.map((file) => `<code>${esc(file)}</code>`).join('<br>')}</td><td></td></tr>`);
  if (!rows.length && !stale.length) return '<p class="dim">None.</p>';
  return `<div class="scroll"><table class="flows"><tr><th></th><th>From</th><th>To</th><th>Why it is allowed</th><th>Accepted for</th><th></th></tr>${[...rows, ...stale].join('')}</table></div>`;
}

/** The dialog and the one script the page carries; nothing at all when no deviation is on the page. */
export function dialog(data) {
  if (Object.keys(data).length === 0) return '';
  return `<dialog id="dev" aria-labelledby="dev-h"><h3 id="dev-h"></h3><p class="why"></p><div class="files"></div><p class="sectionnote">Paste this into Claude Code to scope it:</p><textarea readonly rows="14"></textarea><div class="dlg-b"><button class="primary" id="dev-copy">Copy prompt</button><button id="dev-close">Close</button></div></dialog>
<script type="application/json" id="devs">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>
<script>
const devs = JSON.parse(document.getElementById('devs').textContent), dlg = document.getElementById('dev'), copyBtn = document.getElementById('dev-copy');
document.addEventListener('click', (ev) => {
  const a = ev.target.closest('[data-dev]');
  const d = a && devs[a.dataset.dev];
  if (!d) return;
  ev.preventDefault();
  dlg.querySelector('h3').textContent = d.title;
  dlg.querySelector('.why').textContent = d.why;
  dlg.querySelector('.files').innerHTML = d.files;
  dlg.querySelector('textarea').value = d.prompt;
  copyBtn.textContent = 'Copy prompt';
  dlg.showModal();
});
copyBtn.addEventListener('click', async () => {
  const box = dlg.querySelector('textarea');
  let ok = true;
  try { await navigator.clipboard.writeText(box.value); } catch { box.select(); ok = document.execCommand('copy'); }
  copyBtn.textContent = ok ? 'Copied' : 'Select the text and copy it';
});
document.getElementById('dev-close').addEventListener('click', () => dlg.close());
dlg.addEventListener('click', (ev) => { if (ev.target === dlg) dlg.close(); });
</script>`;
}
