import { formatDate, formatDateTime } from './belgium';
import { categoryName, DEFAULT_GROUP, PERIODS, queryString, WHOS, type CostQuery, type Period } from './costs';
import { COLOURS, dollars, esc, number, PERIOD_LABELS, STYLE, WHO_LABELS } from './page';
import type { CategoryLine, PullRequestPage, SessionLine } from './pull-request';
import { CATEGORIES } from './validate';

const WHERE_NAMES: Record<string, string> = { local: 'Local', cloud: 'Cloud', actions: 'GitHub Actions' };

/** 61,200,000 as "61.2 M". */
export function compact(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} K`;
  return String(n);
}

const unpriced = (n: number) => (n > 0 ? ` <span class="unpriced">+ ${number(n)} unpriced</span>` : '');
const requests = (n: number) => `${number(n)} request${n === 1 ? '' : 's'}`;

/** What a category holds, in a few words. */
function detail(c: CategoryLine): string {
  const measured = c.requests === 0 ? 'none' : requests(c.requests);
  if (c.category === 'local-code-review' && c.requests > 0) {
    return `${c.levels.map((l) => `${l.level === '' ? 'level not recorded' : l.level} × ${number(l.requests)}`).join(' · ')} requests`;
  }
  if (c.category === 'ci-reviews') return `${measured} (@claude) · app reviews <strong>not measured</strong>`;
  return measured;
}

function categories(page: PullRequestPage): string {
  const shown = page.query.category === null ? page.categories : page.categories.filter((c) => c.category === page.query.category);
  const max = Math.max(...shown.map((c) => c.costMicros), 1);
  const rows = shown
    .map(
      (c) =>
        `<div class="cat"><div class="cat-name"><span class="swatch" style="background:${COLOURS[c.category]}" aria-hidden="true"></span>${categoryName(c.category)}</div>` +
        `<div class="track"><div style="width:${((c.costMicros / max) * 100).toFixed(1)}%;height:100%;background:${COLOURS[c.category]}"></div></div>` +
        `<div class="num mono">${dollars(c.costMicros)}${unpriced(c.unpricedRequests)}</div><div class="muted small">${detail(c)}</div></div>`,
    )
    .join('\n');
  return `<section class="card pad" aria-labelledby="bycat"><h2 id="bycat">By category</h2>\n${rows}</section>`;
}

const share = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—');

/** A session's own line, then its main agent and each subagent indented beneath. */
function sessionRows(s: SessionLine): string {
  const head =
    `<tr class="session"><td class="mono small">${esc(s.sessionId)}</td><td>${esc(s.where.map((w) => WHERE_NAMES[w] ?? w).join(', '))}</td><td>${esc(s.models.join(', '))}</td>` +
    `<td class="num mono">${number(s.requests)}</td><td class="num mono">${compact(s.tokens)}</td><td class="num mono total">${dollars(s.costMicros)}${unpriced(s.unpricedRequests)}</td><td></td></tr>`;
  const agents = s.agents.map((a) => {
    const name = a.kind === 'main' ? 'Main agent' : a.type === null ? '<span class="muted">type not recorded</span>' : esc(a.type);
    const id = a.kind === 'main' || a.id === null ? '' : `<span class="mono small muted"> ${esc(a.id)}</span>`;
    return (
      `<tr class="agent ${a.kind}" data-agent="${a.kind}"><td class="agent-name${a.kind === 'subagent' ? ' indent' : ''}">${name}${id}</td><td></td><td>${esc(a.models.join(', '))}</td>` +
      `<td class="num mono">${number(a.requests)}</td><td class="num mono">${compact(a.tokens)}</td><td class="num mono">${dollars(a.costMicros)}${unpriced(a.unpricedRequests)}</td><td class="num mono">${share(a.costMicros, s.costMicros)}</td></tr>`
    );
  });
  return [head, ...agents].join('\n');
}

function sessions(page: PullRequestPage): string {
  if (page.sessions.length === 0) return `<section class="card" aria-labelledby="sessions"><h2 id="sessions" class="pad">Sessions</h2><p class="empty">No requests match the filters.</p></section>`;
  return `<section class="card" aria-labelledby="sessions"><h2 id="sessions" class="pad">Sessions</h2><div class="scroll"><table class="sessions">
<thead><tr><th scope="col" class="first">Session / agent</th><th scope="col">Where</th><th scope="col">Models</th><th scope="col" class="num">Requests</th><th scope="col" class="num">Tokens</th><th scope="col" class="num">Cost</th><th scope="col" class="num">Share</th></tr></thead>
<tbody>
${page.sessions.map(sessionRows).join('\n')}
</tbody></table></div></section>`;
}

/** The filters that apply to one pull request: period, category, model and requests. The engineer is the pull request's own. */
function filters(page: PullRequestPage): string {
  const q = page.query;
  const periods = (Object.keys(PERIODS) as Period[]).map((p) => `<option value="${p}"${p === q.period ? ' selected' : ''}>${PERIOD_LABELS[p]}</option>`).join('');
  const cats = [['', 'All categories'] as const, ...CATEGORIES.map((c) => [c, categoryName(c)] as const)]
    .map(([v, t]) => `<option value="${v}"${v === (q.category ?? '') ? ' selected' : ''}>${esc(t)}</option>`)
    .join('');
  // The models this pull request's sessions used, and the one the address names, so a filter carried in from the costs page shows and can be cleared.
  const used = [...new Set([...page.sessions.flatMap((s) => s.models), ...(q.model === null ? [] : [q.model])])].sort();
  const models = [['', 'All models'] as const, ...used.map((m) => [m, m] as const)]
    .map(([v, t]) => `<option value="${esc(v)}"${v === (q.model ?? '') ? ' selected' : ''}>${esc(t)}</option>`)
    .join('');
  const whos = WHOS.map((w) => `<option value="${w}"${w === q.who ? ' selected' : ''}>${WHO_LABELS[w]}</option>`).join('');
  const csv = `/export.csv?pr=${page.number}${queryString(q, { engineer: null, group: DEFAULT_GROUP, split: 'phase', sort: 'default', page: 1 }).replace('?', '&')}`;
  return `<form class="filters" method="get" action="/pr/${page.number}">
<div class="field"><label for="period">Period</label><select id="period" name="period" onchange="this.form.submit()">${periods}</select></div>
<div class="field"><label for="category">Category</label><select id="category" name="category" onchange="this.form.submit()">${cats}</select></div>
<div class="field"><label for="model">Model</label><select id="model" name="model" onchange="this.form.submit()">${models}</select></div>
<div class="field"><label for="who">Requests</label><select id="who" name="who" onchange="this.form.submit()">${whos}</select></div>
<noscript><button type="submit">Apply</button></noscript>
<a class="button" href="${csv}" download>Export CSV</a>
</form>`;
}

const EXTRA_STYLE = `
.back{display:inline-flex;align-items:center;min-height:44px;align-self:flex-start}
.head{display:flex;flex-wrap:wrap;align-items:flex-start;gap:16px 40px}.head .title{flex:999 1 560px;min-width:0;display:flex;flex-direction:column;gap:6px}
h1{margin:0;font-size:24px;font-weight:600;line-height:1.3}.big{font-size:32px;font-weight:500;text-align:right}.head .total-box{flex:1 1 200px;text-align:right}
.pad{padding:20px;display:flex;flex-direction:column;gap:14px}h2.pad{padding:16px 16px 4px}
.cat{display:grid;grid-template-columns:200px minmax(0,1fr) 150px 300px;gap:16px;align-items:center}.cat-name{display:flex;align-items:center;gap:8px}
.track{height:14px;background:var(--track);border-radius:2px;overflow:hidden}
.sessions{min-width:900px}.sessions tr.session td{font-weight:500;background:var(--track)}.sessions tr.agent td.agent-name{padding-left:28px}.sessions tr.agent td.indent{padding-left:48px}
@media (max-width:900px){.cat{grid-template-columns:1fr 1fr}.track{grid-column:1/-1}}
`;

const periodNote = (q: CostQuery) => PERIOD_LABELS[q.period].toLowerCase();

function summary(page: PullRequestPage): string {
  const merged = page.mergedAt !== null ? `merged ${formatDate(Date.parse(page.mergedAt))}` : page.state.toLowerCase();
  const sessionCount = page.sessions.length;
  const afterPush = page.categories.find((c) => c.category === 'after-push')!;
  const share = page.totalMicros > 0 && page.query.category === null ? ` · ${Math.round((afterPush.costMicros / page.totalMicros) * 100)}% after push` : '';
  return `<div class="head"><div class="title"><h1>#${page.number} ${esc(page.title)}</h1>
<div class="muted">${page.issue === null ? 'Closes no issue' : `Closes issue ${page.issue}`} · ${page.engineer === null ? 'unknown author' : esc(page.engineer)} · ${esc(merged)} · ${number(sessionCount)} session${sessionCount === 1 ? '' : 's'} · branch ${page.branches.map((b) => `<span class="mono">${esc(b)}</span>`).join(', ')}</div></div>
<div class="total-box"><div class="mono big" id="pr-total">${dollars(page.totalMicros)}${unpriced(page.unpricedRequests)}</div><div class="muted">at API list price, ${periodNote(page.query)}${share}</div></div></div>`;
}

function shell(body: string, now: number): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Harness Monitor</title>
<style>${STYLE}${EXTRA_STYLE}</style>
</head><body>
<header><div class="name">Harness Monitor</div><a class="section" href="/" style="text-decoration:none;color:inherit">Claude Code costs</a>
<span class="status">Updated ${formatDateTime(now)} · Public, read-only.</span></header>
<main>
<a class="back" href="/">&larr; All costs</a>
${body}
</main>
</body></html>`;
}

/** One pull request's cost. Counts, dollars and opaque ids only; never an email or any content. */
export function renderPullRequest(page: PullRequestPage, now = Date.now()): string {
  return shell(`${summary(page)}\n${filters(page)}\n${categories(page)}\n${sessions(page)}`, now);
}

/** A number no pull request is known by. */
export function renderNothingFound(now = Date.now()): string {
  return shell(`<section class="card"><p class="empty">Nothing found. No pull request with that number has been linked to any Claude Code request.</p></section>`, now);
}
