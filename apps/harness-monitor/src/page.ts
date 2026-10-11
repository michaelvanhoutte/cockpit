import type { ListStatus } from './price-list';
import type { DayLine, UnpricedLine } from './store';

const number = (n: number) => n.toLocaleString('en-US');
const dollars = (micros: number) => `$${(micros / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** Model names come from whoever holds the write key, so they are escaped. */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function age(from: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - from) / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return `${Math.floor(hours / 24)} days`;
}

/** How old the price list is, and whether the last attempt to refresh it failed. */
function listLine(list: ListStatus, now: number): string {
  const when = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
  const base =
    list.fetchedAt === null
      ? 'No price list has been fetched yet; only the repository&rsquo;s own prices apply.'
      : `Price list fetched ${age(list.fetchedAt, now)} ago (${when(list.fetchedAt)} UTC).`;
  const failed =
    list.lastError !== null && list.lastAttemptAt !== null
      ? ` The fetch at ${when(list.lastAttemptAt)} UTC failed (${esc(list.lastError)}); ${list.fetchedAt === null ? 'nothing is priced from it' : 'the last good list is still in use'}.`
      : '';
  return `<p class="list">${base}${failed}</p>`;
}

function warning(unpriced: UnpricedLine[]): string {
  if (unpriced.length === 0) return '';
  const requests = unpriced.reduce((sum, u) => sum + u.requests, 0);
  const rows = unpriced
    .map(
      (u) =>
        `<tr><td>${esc(u.model)}</td><td>${number(u.requests)}</td><td>${number(u.inputTokens)}</td><td>${number(u.outputTokens)}</td><td>${number(u.cacheCreationTokens)}</td><td>${number(u.cacheReadTokens)}</td><td>${number(u.branches)}</td></tr>`,
    )
    .join('\n');
  return `<section class="warning"><h2>Tokens with no price</h2>
<p>${number(requests)} request${requests === 1 ? '' : 's'} could not be priced: the price list does not cover the model, or has no rate for a kind of token it used. They are left out of every dollar total and priced by the daily job once the list covers them.</p>
<table>
<thead><tr><th>Model</th><th>Requests</th><th>Input</th><th>Output</th><th>Cache write</th><th>Cache read</th><th>Branches</th></tr></thead>
<tbody>
${rows}
</tbody></table></section>`;
}

/** The public page: tokens and dollars per day, newest first. Counts only; never an email or any content. */
export function renderPage(
  lines: DayLine[],
  report: { unpriced: UnpricedLine[]; list: ListStatus },
  now = Date.now(),
): string {
  const body =
    lines.length === 0
      ? '<p>Nothing yet. No Claude Code requests have been reported.</p>'
      : `<table>
<thead><tr><th>Day (UTC)</th><th>Requests</th><th>Input</th><th>Output</th><th>Cache write</th><th>Cache read</th><th>Cost (priced requests)</th></tr></thead>
<tbody>
${lines
  .map(
    (l) =>
      `<tr><td>${l.day}</td><td>${number(l.requests)}</td><td>${number(l.inputTokens)}</td><td>${number(l.outputTokens)}</td><td>${number(l.cacheCreationTokens)}</td><td>${number(l.cacheReadTokens)}</td><td>${dollars(l.costMicros)}${l.unpricedRequests > 0 ? ` <span class="unpriced">+ ${number(l.unpricedRequests)} unpriced</span>` : ''}</td></tr>`,
  )
  .join('\n')}
</tbody></table>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Harness Monitor</title>
<style>body{font:16px system-ui,sans-serif;margin:2rem auto;max-width:56rem;padding:0 1rem}table{border-collapse:collapse;width:100%}th,td{padding:.4rem .6rem;text-align:right;border-bottom:1px solid #8884}th:first-child,td:first-child{text-align:left}.warning{border:2px solid #c80;padding:0 1rem 1rem;margin:1rem 0}.unpriced{color:#c80;font-size:.85em}.list{color:#666}</style>
</head><body><h1>Harness Monitor</h1>
${warning(report.unpriced)}
<h2>Tokens and cost per day</h2>
${listLine(report.list, now)}
${body}
</body></html>`;
}
