import { formatDate } from './belgium';
import { categoryName, DEFAULT_GROUP, PERIODS, queryString, WHOS, type CostQuery, type Period } from './costs';
import { WHAT } from './costs-explain';
import { EXPLAIN_SCRIPT, EXPLAIN_STYLE, explain } from './explain';
import { band, esc, selectField, shell } from './look';
import { COLOURS, costsLead, dollars, number, PERIOD_LABELS, WHO_LABELS } from './page';
import type { CategoryLine, PullRequestPage, SessionLine } from './pull-request';
import { stripOf } from './pull-request-strip';
import { renderTimeline } from './pull-request-timeline';
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

/** What both cost sections say of a pull request that has no branch link: nothing was spent on it that the Monitor can tie to it. */
const NO_SESSIONS = 'No Claude Code sessions are linked to this pull request.';

function categories(page: PullRequestPage): string {
  if (page.branches.length === 0) return `<section class="panel" aria-labelledby="bycat">${band('By category', '', 'bycat', explain('bycat', 'By category', WHAT.byCategory).both)}<p class="well empty">${NO_SESSIONS}</p></section>`;
  // Unphased is listed only when it holds cost; a category filter lists the one it names.
  const shown =
    page.query.category === null
      ? page.categories.filter((c) => c.category !== 'unphased' || c.costMicros > 0)
      : page.categories.filter((c) => c.category === page.query.category);
  const max = Math.max(...shown.map((c) => c.costMicros), 1);
  const rows = shown
    .map(
      (c) =>
        `<div class="cat"><div class="cat-name"><span class="swatch" style="background:${COLOURS[c.category]}" aria-hidden="true"></span>${categoryName(c.category)}</div>` +
        `<div class="track"><div style="width:${((c.costMicros / max) * 100).toFixed(1)}%;height:100%;background:${COLOURS[c.category]}"></div></div>` +
        `<div class="num mono">${dollars(c.costMicros)}${unpriced(c.unpricedRequests)}</div><div class="muted small">${detail(c)}</div></div>`,
    )
    .join('\n');
  return `<section class="panel" aria-labelledby="bycat">${band('By category', '', 'bycat', explain('bycat', 'By category', WHAT.byCategory).both)}<div class="well pad">\n${rows}</div></section>`;
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
  const title = band('Sessions', '', 'sessions', explain('sessions', 'Sessions', WHAT.sessions).both);
  if (page.branches.length === 0) return `<section class="panel" aria-labelledby="sessions">${title}<p class="well empty">${NO_SESSIONS}</p></section>`;
  if (page.sessions.length === 0) return `<section class="panel" aria-labelledby="sessions">${title}<p class="well empty">No requests match the filters.</p></section>`;
  return `<section class="panel" aria-labelledby="sessions">${title}<div class="well scroll"><table class="sessions">
<thead><tr><th scope="col" class="first">Session / agent</th><th scope="col">Where</th><th scope="col">Models</th><th scope="col" class="num">Requests</th><th scope="col" class="num">Tokens</th><th scope="col" class="num">Cost</th><th scope="col" class="num">Share</th></tr></thead>
<tbody>
${page.sessions.map(sessionRows).join('\n')}
</tbody></table></div></section>`;
}

/** The filters that apply to one pull request: period, category, model and requests. The engineer is the pull request's own. */
function filters(page: PullRequestPage): string {
  const q = page.query;
  // The models this pull request's sessions used, and the one the address names, so a filter carried in from the costs page shows and can be cleared.
  const used = [...new Set([...page.sessions.flatMap((s) => s.models), ...(q.model === null ? [] : [q.model])])].sort();
  const csv = `/export.csv?pr=${page.number}${queryString(q, { engineer: null, group: DEFAULT_GROUP, split: 'phase', sort: 'default', page: 1 }).replace('?', '&')}`;
  return `<form class="filters" method="get" action="/pr/${page.number}">
${selectField('period', 'Period', (Object.keys(PERIODS) as Period[]).map((p): [string, string] => [p, PERIOD_LABELS[p]]), q.period, '30d')}
${selectField('category', 'Category', [['', 'All categories'], ...CATEGORIES.map((c): [string, string] => [c, categoryName(c)])], q.category ?? '')}
${selectField('model', 'Model', [['', 'All models'], ...used.map((m): [string, string] => [m, m])], q.model ?? '')}
${selectField('who', 'Requests', WHOS.map((w): [string, string] => [w, WHO_LABELS[w]]), q.who, 'all')}
<noscript><button type="submit">Apply</button></noscript>
<a class="button" href="${csv}" download>Export CSV</a>
</form>`;
}

const periodNote = (q: CostQuery) => PERIOD_LABELS[q.period].toLowerCase();

function summary(page: PullRequestPage): string {
  const merged = page.mergedAt !== null ? `merged ${formatDate(Date.parse(page.mergedAt))}` : page.state.toLowerCase();
  // A pull request only cycle time holds has no branch, so no sessions and no cost to total.
  if (page.branches.length === 0) {
    return `<div class="head"><div class="title"><h1>#${page.number} ${esc(page.title)}</h1>
<div class="muted">${esc(merged)} · no Claude Code sessions are linked</div></div></div>`;
  }
  const sessionCount = page.sessions.length;
  const afterPush = page.categories.find((c) => c.category === 'after-push')!;
  const share = page.totalMicros > 0 && page.query.category === null ? ` · ${Math.round((afterPush.costMicros / page.totalMicros) * 100)}% after push` : '';
  return `<div class="head"><div class="title"><h1>#${page.number} ${esc(page.title)}</h1>
<div class="muted">${page.issue === null ? 'Closes no issue' : `Closes issue ${page.issue}`} · ${page.engineer === null ? 'unknown author' : esc(page.engineer)} · ${esc(merged)} · ${number(sessionCount)} session${sessionCount === 1 ? '' : 's'} · branch ${page.branches.map((b) => `<span class="mono">${esc(b)}</span>`).join(', ')}</div></div>
<div class="total-box"><div class="mono big" id="pr-total">${dollars(page.totalMicros)}${unpriced(page.unpricedRequests)}</div><div class="muted">at API list price, ${periodNote(page.query)}${share}</div></div></div>`;
}

/**
 * The pull request's timeline above its sessions: its strip from the stored rows, or "timeline not recorded" where the
 * Monitor holds none that fits, never an empty strip. Nothing where cycle time holds no such pull request.
 */
function timeline(page: PullRequestPage): { html: string; style: string } {
  if (page.timeline === null) return { html: '', style: '' };
  const { pull, timeline: stored } = page.timeline;
  const title = band('Timeline', '', 'timeline');
  if (stored === null) return { html: `<section class="panel" aria-labelledby="timeline">${title}<p class="well empty">Timeline not recorded.</p></section>`, style: '' };
  const drawn = renderTimeline(stripOf(pull, stored), { name: pull.base, trunk: pull.base === 'main', landing: pull.landing, head: pull.head });
  return { html: `<section class="panel tl" aria-labelledby="timeline">${title}<div class="well pad">${drawn.html}</div></section>`, style: drawn.style };
}

/** A pull request's page is part of the costs page: its tab stays current, over a band with no groupings, and it opens with that tab's lead. */
const framed = (body: string, now: number, style = '') =>
  shell({ current: 'costs', body: `${costsLead()}\n<a class="back" href="/">&larr; All costs</a>\n${body}\n${EXPLAIN_SCRIPT}`, style: EXPLAIN_STYLE + style }, now);

/** One pull request's cost. Counts, dollars and opaque ids only; never an email or any content. */
export function renderPullRequest(page: PullRequestPage, now = Date.now()): string {
  const drawn = timeline(page);
  // The filters narrow the cost, and a pull request with no branch link has none.
  const narrowing = page.branches.length === 0 ? '' : `${filters(page)}\n`;
  return framed(`${summary(page)}\n${drawn.html}\n${narrowing}${categories(page)}\n${sessions(page)}`, now, drawn.style);
}

/** A number no pull request is known by. */
export function renderNothingFound(now = Date.now()): string {
  return framed(`<h1 class="sr-only">Pull request</h1><section class="panel">${band('Pull request')}<p class="well empty">Nothing found. No pull request with that number has been linked to a Claude Code request or stored by cycle time.</p></section>`, now);
}
