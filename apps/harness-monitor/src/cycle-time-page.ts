import { addDays, belgianDay, formatDateTime, formatDay, startOfDay } from './belgium';
import type { CycleTimeView } from './cycle-time-store';
import { esc, selectField } from './look';
import { dollars, number, REPOSITORY } from './page';
import { bandTabs, outLink, reportPage, section, tile } from './report';
import {
  buckets,
  checkRows,
  costOf,
  cycleTimeAddress,
  filtered,
  flukeCount,
  GROUP_LABELS,
  GROUPS,
  harnessShare,
  hm,
  lines,
  mergedMs,
  OUTCOMES,
  PERIOD_CHOICES,
  PERIODS,
  plural,
  quantile,
  redRounds,
  seriesOf,
  SERIES,
  SIZES,
  sizeOf,
  SPLIT_LABELS,
  SPLITS,
  splitTotals,
  startToMerge,
  sum,
  TOTAL_LABELS,
  totalOf,
  values,
  type CycleTimeQuery,
  type Pull,
  type Split,
} from './cycle-time-report';

/** The report pages' one violet ramp, darkest first (look.ts defines the --cat-* names as its steps); grey is for other or none. */
const RAMP = ['var(--cat-violet)', 'var(--cat-slate)', 'var(--cat-teal)', 'var(--cat-green)', 'var(--cat-amber)'];
const GREY = 'var(--cat-grey)';

/** Each split's series with the colour it is drawn in: the ramp in stacking order, grey for the ones marked other. */
const COLOURED = Object.fromEntries(
  SPLITS.map((split) => {
    let step = 0;
    return [split, SERIES[split].map((s) => ({ ...s, colour: s.other ? GREY : RAMP[step++ % RAMP.length]! }))];
  }),
) as Record<Split, { key: string; label: string; colour: string }[]>;

const unrecordedNote = (n: number, split: Split) =>
  n === 0
    ? ''
    : ` ${plural(n, 'pull request')} here ${n === 1 ? 'carries' : 'carry'} no session record: ${
        split === 'phase' ? `${n === 1 ? 'its' : 'their'} writing starts at the first commit and ${n === 1 ? 'its' : 'their'}` : n === 1 ? 'its' : 'their'
      } local checks are not recorded, which is not zero.`;

/** The cycle time page: the same pull requests whatever the tab, narrowed by the filters, with the tiles and overview panels only on the first. */
export function renderCycleTime(q: CycleTimeQuery, view: CycleTimeView, repository: string | undefined, now: number): string {
  const repo = repository !== undefined && REPOSITORY.test(repository) ? repository : null;
  const { list, previous } = filtered(view.pulls, q, now);
  const cost = (p: Pull) => costOf(view.costs, p);
  const issueOf = (p: Pull) => view.costs.get(p.number)?.issue ?? null;
  /** A split's series in colour, as far as this list draws them. */
  const drawn = (split: Split) => COLOURED[split].filter((c) => seriesOf(list, split).some((s) => s.key === c.key));
  /** A pull request's Sessions page exists only for one the Monitor has a branch link for; any other would be nothing found. */
  const sessions = (number: number) => view.costs.has(number);
  const sessionsLink = (number: number, text: string) => (sessions(number) ? `<a href="/pr/${number}">${text}</a>` : '');
  const opening = (number: number, inner: string) => (sessions(number) ? `<a href="/pr/${number}">${inner}</a>` : inner);
  const link = (over: Partial<CycleTimeQuery>) => esc(cycleTimeAddress(q, over));

  /** The tiles: a pull request's start to merge, how much of it was the harness, CI rounds, and what the Claude Code sessions cost. */
  function stats(): string {
    const { median, p95, before } = startToMerge(list, previous);
    const compare =
      median !== null && before !== null
        ? ` · <span class="${median > before ? 'up' : 'down'}">${median > before ? '▲' : '▼'} ${hm(Math.abs(median - before))}</span> on the ${PERIODS[q.period]} days before`
        : '';
    const { share, ratio } = harnessShare(list);
    const rounds = sum(list.map((p) => p.rounds.length));
    const red = sum(list.map(redRounds));
    const flukes = sum(list.map(flukeCount));
    const priced = list.filter((p) => cost(p) !== null);
    const spent = sum(priced.map((p) => cost(p)!.micros));
    return `<div class="tiles">
${tile('Start to merge', median === null ? '—' : hm(median), median === null ? 'no pull request merged' : `median of ${plural(list.length, 'pull request')} · p95 ${hm(p95!)}${compare}`)}
${tile('In the harness', share === null ? '—' : `${Math.round(share * 100)}%`, ratio === null ? 'no pull request with a session record' : `of writing plus harness · median ${ratio.toFixed(1)}× the writing`)}
${tile('CI rounds', number(rounds), list.length ? `${(rounds / list.length).toFixed(1)} a pull request · ${plural(red, 'red round')} · ${plural(flukes, 'fluke')}` : 'none')}
${tile('Claude Code cost', priced.length ? dollars(spent) : '—', priced.length ? `${dollars(spent / priced.length)} a pull request · ${number(priced.length)} of ${number(list.length)} priced` : 'none priced')}
</div>`;
  }

  /** Where the time went: one bar over the list, cut by the split. */
  function where(): string {
    const series = drawn(q.split);
    const { byKey, all, union } = splitTotals(list, q.split);
    const shown = series.filter((s) => (byKey.get(s.key) ?? 0) > 0);
    const bar = shown.map((s) => `<div style="flex:${byKey.get(s.key)};background:${s.colour}" title="${esc(s.label)} ${hm(byKey.get(s.key)!)}"></div>`).join('');
    const legend = shown
      .map((s) => `<li><i style="background:${s.colour}"></i><span class="name">${esc(s.label)}</span><span class="amount">${hm(byKey.get(s.key)!)}</span><span class="share">${all ? Math.round((byKey.get(s.key)! / all) * 100) : 0}%</span></li>`)
      .join('');
    const noRecord = unrecordedNote(list.filter((p) => !p.balance).length, q.split);
    const notes: Record<Split, string> = {
      phase: `Start to merge, cut into its parts. Writing is the time before the first push and the fixing between rounds, less local checks; local checks are the session&rsquo;s own reviews, test runs and browser pass; a CI round runs from a push to its last check finishing. Time before the session started is not measured.${noRecord}`,
      harness: `Each kind&rsquo;s own minutes as the session record marked them. Kinds that ran at the same time count in each, and so does time the harness leaves out, such as a review that ran during a CI round, so they add up to ${hm(Math.max(0, all - union))} more than the ${hm(union)} the harness took.${series.some((s) => s.key === 'reviews') ? ' Pull requests stored before the review kinds were kept have one figure for both reviews, drawn as Reviews, not split by kind.' : ''}${noRecord}`,
      check: 'Each CI round&rsquo;s time charged to the check that held it: every check is charged the time since the one before it finished, so checks in flight together count once, and the last to finish is the one the round waited on.',
    };
    return section(
      'where-it-went',
      `Where the ${hm(all)} went`,
      `by ${SPLIT_LABELS[q.split].toLowerCase()} · ${plural(list.length, 'pull request')}`,
      `<div class="well where">
<div class="bar" role="img" aria-label="${esc(shown.map((s) => `${s.label} ${hm(byKey.get(s.key)!)}`).join(', '))}">${bar}</div>
<ul class="shares">${legend}</ul>
<p class="note">${notes[q.split]}</p>
</div>`,
      'panel wide',
    );
  }

  /** Coding against the harness: a dot per pull request with a session record, on one scale for both axes up to two hours. */
  function scatter(): string {
    const dots = list.filter((p) => p.balance);
    const S = { size: 300, left: 30, bottom: 30, top: 22, right: 12 };
    const scale = 2 * 3_600_000;
    const plot = S.size - S.left - S.right;
    const plotH = S.size - S.top - S.bottom;
    const x = (ms: number) => S.left + (Math.min(ms, scale) / scale) * plot;
    const y = (ms: number) => S.top + plotH - (Math.min(ms, scale) / scale) * plotH;
    const ratio = harnessShare(list).ratio;
    const maxLines = Math.max(1, ...dots.map(lines));
    const colour = (rounds: number) => (rounds >= 3 ? 'var(--over)' : 'var(--cat-slate)');
    const grid = [0, 0.5, 1]
      .map(
        (f) =>
          `<line x1="${S.left}" x2="${S.left + plot}" y1="${y(scale * f)}" y2="${y(scale * f)}" class="gridline"/><text x="${S.left - 6}" y="${y(scale * f) + 4}" text-anchor="end" class="axis">${f * 2}h</text><text x="${x(scale * f)}" y="${S.size - 12}" text-anchor="${f === 1 ? 'end' : 'middle'}" class="axis">${f * 2}h</text>`,
      )
      .join('');
    const equal = `<line x1="${x(0)}" y1="${y(0)}" x2="${x(scale)}" y2="${y(scale)}" class="equal"/>`;
    const median = ratio === null ? '' : `<line x1="${x(0)}" y1="${y(0)}" x2="${x(ratio >= 1 ? scale / ratio : scale)}" y2="${y(ratio >= 1 ? scale : scale * ratio)}" class="median"/>`;
    let off = 0;
    const marks = [...dots]
      .sort((a, b) => lines(b) - lines(a))
      .map((p) => {
        const b = p.balance!;
        const out = b.codingMs > scale || b.harnessMs > scale;
        if (out) off++;
        const r = 3 + 6 * Math.sqrt(lines(p) / maxLines);
        const c = colour(p.rounds.length);
        return opening(p.number, `<circle cx="${x(b.codingMs).toFixed(1)}" cy="${y(b.harnessMs).toFixed(1)}" r="${r.toFixed(1)}" fill="${out ? 'none' : c}" stroke="${c}" class="dot"><title>#${p.number} ${esc(p.title)} · writing ${hm(b.codingMs)} · harness ${hm(b.harnessMs)} · ${plural(p.rounds.length, 'round')} · ${plural(lines(p), 'line')}</title></circle>`);
      })
      .join('');
    const keys = [
      ['var(--cat-slate)', 'a pull request'],
      ['var(--over)', '3 rounds or more'],
    ]
      .map(([c, t]) => `<span class="key"><i style="background:${c}"></i>${t}</span>`)
      .join('');
    const above = dots.filter((p) => p.balance!.harnessMs > p.balance!.codingMs).length;
    return section(
      'writing-against-harness',
      'Writing against the harness',
      '',
      `<div class="well scatter-well">
<svg viewBox="0 0 ${S.size} ${S.size}" role="img" aria-label="A dot per pull request: minutes writing across, minutes in the harness up">${grid}${equal}${median}${marks}<text x="${S.left + plot / 2}" y="${S.size - 1}" text-anchor="middle" class="axis">writing →</text><text x="${S.left - 6}" y="${S.top - 10}" class="axis">↑ harness</text></svg>
<div class="legend">${keys}<span class="key"><i class="dash"></i>as long as the writing</span>${ratio === null ? '' : '<span class="key"><i class="solid"></i>median</span>'}</div>
<p class="note">${dots.length ? `${number(above)} of ${plural(dots.length, 'pull request')} spent longer in the harness than writing${ratio === null ? '' : `; the median took ${ratio.toFixed(1)}× its writing`}. Dot size is lines changed${off ? `; ${plural(off, 'dot')} past two hours ${off === 1 ? 'sits' : 'sit'} hollow on the edge` : ''}. A dot opens its Sessions.` : 'No pull request here carries a session record.'}</p>
</div>`,
      'panel narrow',
    );
  }

  /** A stacked bar per pull request at the moment it merged, so a busy day looks busy and a quiet one quiet. */
  function overTime(): string {
    const series = drawn(q.split);
    const days = PERIODS[q.period];
    const firstDay = days === null ? belgianDay(Math.min(...list.map(mergedMs), now)) : addDays(belgianDay(now), -(days - 1));
    const t0 = startOfDay(firstDay);
    const t1 = startOfDay(addDays(belgianDay(now), 1));
    const { width, height, left, right, top, bottom } = { width: 1000, height: 260, left: 64, right: 12, top: 12, bottom: 30 };
    const plotW = width - left - right;
    const plotH = height - top - bottom;
    const stacks = list.map((p) => {
      const v = values(p, q.split);
      return { p, v, total: sum(series.map((s) => v[s.key] ?? 0)) };
    });
    const tallest = Math.max(60_000, ...stacks.map((s) => s.total));
    const cap = q.split === 'phase' ? Math.min(tallest, 4 * 3_600_000) : tallest;
    const x = (t: number) => left + ((t - t0) / (t1 - t0)) * plotW;
    const y = (ms: number) => top + plotH - (Math.min(ms, cap) / cap) * plotH;
    const barW = Math.max(2, Math.min(8, plotW / Math.max(list.length, 1) - 1));
    const grid = [0, 0.5, 1].map((f) => `<line x1="${left}" x2="${width - right}" y1="${y(cap * f).toFixed(1)}" y2="${y(cap * f).toFixed(1)}" class="gridline"/><text x="${left - 10}" y="${(y(cap * f) + 4).toFixed(1)}" text-anchor="end" class="axis">${f === 0 ? '0' : hm(cap * f)}</text>`).join('');
    const dayList: string[] = [];
    for (let d = firstDay; startOfDay(d) < t1; d = addDays(d, 1)) dayList.push(d);
    const every = Math.ceil(dayList.length / 8);
    const ticks = dayList
      .map((d, i) => `<line x1="${x(startOfDay(d)).toFixed(1)}" x2="${x(startOfDay(d)).toFixed(1)}" y1="${top}" y2="${top + plotH}" class="gridline"/>${i % every === 0 ? `<text x="${x(startOfDay(d) + 43_200_000).toFixed(1)}" y="${height - 8}" text-anchor="middle" class="axis">${formatDay(d)}</text>` : ''}`)
      .join('');
    const bars = stacks
      .map(({ p, v, total }) => {
        const cx = x(mergedMs(p));
        let at = 0;
        const rects = series
          .map((s) => {
            const ms = v[s.key] ?? 0;
            if (ms <= 0 || at >= cap) return '';
            const y0 = y(at);
            at += ms;
            const y1 = y(at);
            return `<rect x="${(cx - barW / 2).toFixed(1)}" y="${y1.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0.5, y0 - y1).toFixed(1)}" fill="${s.colour}"><title>#${p.number} ${esc(p.title)} · ${esc(s.label)} ${hm(ms)} · ${TOTAL_LABELS[q.split].toLowerCase()} ${hm(totalOf(p, q.split))}</title></rect>`;
          })
          .join('');
        const cut = total > cap ? `<path d="M${(cx - barW / 2 - 1).toFixed(1)} ${top + 6} l${(barW / 2 + 1).toFixed(1)} -6 l${(barW / 2 + 1).toFixed(1)} 6z" class="cut"><title>#${p.number} runs past the scale: ${hm(total)}</title></path>` : '';
        return opening(p.number, `${rects}${cut}`);
      })
      .join('');
    const legend = series.map((s) => `<span class="key"><i style="background:${s.colour}"></i>${esc(s.label)}</span>`).join('');
    const cutNote = tallest > cap ? ' · cut at 4h' : '';
    return section(
      'per-pull-request',
      `${TOTAL_LABELS[q.split]}, each pull request as it merged`,
      `<span class="legend">${legend}</span>`,
      `<div class="well chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${TOTAL_LABELS[q.split]} per pull request, by when it merged">${grid}${ticks}${bars}</svg><p class="chart-note">A bar per pull request, at the moment it merged${cutNote}. A bar opens its Sessions.</p></div>`,
    );
  }

  const prLink = (p: Pull, text: string) => outLink(p.url, text);

  function prLabel(p: Pull): { label: string; sub: string } {
    const red = redRounds(p);
    const flukes = flukeCount(p);
    const bits = [
      `merged ${formatDateTime(mergedMs(p))}`,
      `${plural(p.rounds.length, 'round')}${red ? ` (<span class="up">${red} red</span>)` : ''}${flukes ? ` · ${plural(flukes, 'fluke')}` : ''}`,
      plural(lines(p), 'line'),
      p.base !== 'main' ? `into ${esc(p.base)}` : '',
      p.recorded ? '' : '<span class="tag">no session record</span>',
      sessionsLink(p.number, 'Sessions'),
    ];
    return { label: prLink(p, `<span class="pr-no">#${p.number}</span> ${esc(p.title)}`), sub: bits.filter(Boolean).join(' · ') };
  }

  /** The rows of the Pull request, Issue, Size and Over time tabs. */
  function table(group: Exclude<CycleTimeQuery['group'], 'check'>): string {
    const series = drawn(q.split);
    const all = buckets(group, list, issueOf);
    if (all.length === 0) return section('cycle-table', GROUP_LABELS[group], '', '<p class="well empty">Nothing in this period. No merged pull request matches these filters.</p>', 'panel wide');
    const perPull = group === 'pr';
    const summed = group === 'issue';
    /** A row's minutes: a pull request's own, an issue's added up, a day's or a size's per pull request on average. */
    const fold = (pulls: Pull[], f: (p: Pull) => number) => sum(pulls.map(f)) / (perPull || summed ? 1 : pulls.length);
    const rows = all.map((b) => ({ b, cells: series.map((s) => fold(b.pulls, (p) => values(p, q.split)[s.key] ?? 0)), total: fold(b.pulls, (p) => totalOf(p, q.split)) }));
    // Scaled to the 90th percentile row, so one pull request away for a night does not flatten every other bar.
    const max = Math.max(1, quantile(rows.map((r) => sum(r.cells)), 0.9) ?? 1);
    const heads = series.map((s) => `<th scope="col" class="num"><i style="background:${s.colour}"></i>${esc(s.label)}</th>`).join('');
    const body = rows
      .map(({ b, cells, total }) => {
        const one = b.pulls[0]!;
        let label: string;
        let sub = '';
        if (perPull) ({ label, sub } = prLabel(one));
        else if (group === 'day') label = `<span class="nowrap">${esc(formatDay(b.key))}</span>`;
        else if (group === 'size') label = esc(SIZES.find((s) => s.key === b.key)!.label);
        else if (b.issue === null) label = 'No issue named';
        else {
          const named = b.pulls.map((p) => view.costs.get(p.number)?.issueTitle).find((t) => t);
          const text = `<span class="pr-no">#${b.issue}</span> ${esc(named ?? one.title.replace(/\s*\(#\d+\)\s*$/, ''))}`;
          label = repo ? outLink(`https://github.com/${repo}/issues/${b.issue}`, text) : text;
          sub = b.pulls.map((p) => [prLink(p, `#${p.number}`), sessionsLink(p.number, 'Sessions')].filter(Boolean).join(' ')).join(' · ');
        }
        const bar = cells.map((ms, i) => (ms > 0 ? `<div style="flex:0 0 ${((ms / max) * 100).toFixed(1)}%;background:${series[i]!.colour}"></div>` : '')).join('');
        const cellHtml = cells
          .map((ms, i) => {
            const unrecorded = perPull && values(one, q.split)[series[i]!.key] === null;
            return `<td class="num">${unrecorded ? '<span class="faint">not recorded</span>' : ms > 0 ? hm(ms) : '<span class="faint">—</span>'}</td>`;
          })
          .join('');
        const rounds = sum(b.pulls.map((p) => p.rounds.length));
        const red = sum(b.pulls.map(redRounds));
        const priced = b.pulls.filter((p) => cost(p) !== null);
        const spent = sum(priced.map((p) => cost(p)!.micros));
        const unpriced = sum(priced.map((p) => cost(p)!.unpricedRequests));
        const notes = [priced.length < b.pulls.length && !perPull ? `${priced.length} of ${b.pulls.length} priced` : '', unpriced ? `${plural(unpriced, 'request')} not priced` : ''].filter(Boolean);
        const costCell = priced.length
          ? `${perPull ? `<a href="/pr/${one.number}">${dollars(spent)}</a>` : dollars(spent)}${notes.length ? `<div class="sub">${notes.join(' · ')}</div>` : ''}`
          : '<span class="faint" title="The Monitor holds no Claude Code request for it">—</span>';
        return `<tr><td class="first">${label}${sub ? `<div class="sub">${sub}</div>` : ''}</td>${perPull ? '' : `<td class="num faint-num">${number(b.pulls.length)}</td>`}<td class="split-cell"><div class="split">${bar}</div></td>${cellHtml}<td class="num total">${hm(total)}</td><td class="num">${number(rounds)}${red ? ` <span class="up">· ${red} red</span>` : ''}</td><td class="num total">${costCell}</td></tr>`;
      })
      .join('\n');
    const how = perPull ? 'newest first' : summed ? 'its pull requests added up · newest first' : group === 'day' ? 'a pull request on average · newest first' : 'a pull request on average';
    const noun = group === 'day' ? 'day' : group === 'size' ? 'size' : group === 'issue' ? 'issue' : 'pull request';
    return section(
      'cycle-table',
      `By ${group === 'day' ? 'day merged' : GROUP_LABELS[group].toLowerCase()}`,
      `${plural(all.length, noun)} · ${how}`,
      `<div class="well table"><table>
<thead><tr><th scope="col">${group === 'day' ? 'Day merged' : GROUP_LABELS[group]}</th>${perPull ? '' : '<th scope="col" class="num">Pull requests</th>'}<th scope="col">Split</th>${heads}<th scope="col" class="num">${TOTAL_LABELS[q.split]}</th><th scope="col" class="num">Rounds</th><th scope="col" class="num">Claude Code</th></tr></thead>
<tbody>${body}</tbody></table></div>`,
      'panel wide',
    );
  }

  /** Which check held the rounds up. */
  function checks(): string {
    const { rows, rounds } = checkRows(list);
    if (list.length === 0) return section('by-check', 'By check', '', '<p class="well empty">Nothing in this period. No merged pull request matches these filters.</p>', 'panel wide');
    if (rows.length === 0) return section('by-check', 'By check', '', '<p class="well empty">No CI round in these pull requests.</p>', 'panel wide');
    const colourOf = (name: string) => COLOURED.check.find((s) => s.key === name)?.colour ?? GREY;
    const max = Math.max(1, ...rows.map((r) => r.ms));
    const all = sum(list.flatMap((p) => p.rounds.map((r) => r.ms)));
    const body = rows
      .map(
        (r) =>
          `<tr><td class="first"><i class="swatch" style="background:${colourOf(r.name)}"></i>${esc(r.name)}${r.redPulls.length ? `<div class="sub">red on ${r.redPulls.slice(0, 6).map((n) => (sessions(n) ? `<a href="/pr/${n}">#${n}</a>` : `#${n}`)).join(', ')}${r.redPulls.length > 6 ? ` and ${r.redPulls.length - 6} more` : ''}</div>` : ''}</td><td class="num">${number(r.held)}</td><td class="num">${number(r.last)}</td><td class="split-cell"><div class="split"><div style="width:${((r.ms / max) * 100).toFixed(1)}%;background:${colourOf(r.name)}"></div></div></td><td class="num total">${hm(r.ms)}</td><td class="num faint-num">${all ? Math.round((r.ms / all) * 100) : 0}%</td><td class="num">${r.median === null ? '—' : hm(r.median)}</td><td class="num">${r.red ? `<span class="up">${r.red}</span>` : '<span class="faint">—</span>'}</td><td class="num">${r.flukes || '<span class="faint">—</span>'}</td><td class="num">${r.queue === null ? '<span class="faint">not recorded</span>' : hm(r.queue)}</td></tr>`,
      )
      .join('\n');
    return section(
      'by-check',
      'By check',
      `${plural(rounds, 'CI round')} · most minutes first`,
      `<div class="well table"><table>
<thead><tr><th scope="col">Check</th><th scope="col" class="num">Rounds it held</th><th scope="col" class="num">Finished last</th><th scope="col">Held for</th><th scope="col" class="num">Minutes</th><th scope="col" class="num">Share</th><th scope="col" class="num">A round, median</th><th scope="col" class="num">Red rounds</th><th scope="col" class="num">Flukes</th><th scope="col" class="num">Queue, median</th></tr></thead>
<tbody>${body}</tbody></table></div>`,
      'panel wide',
    );
  }

  // The default tab is the overview; every other tab goes straight from the filters to its own table.
  const overview = q.group === 'day' ? `${stats()}\n<div class="row">${where()}${scatter()}</div>\n${list.length ? overTime() : ''}\n` : '';
  const content = `${overview}${q.group === 'check' ? checks() : table(q.group)}`;

  const days = PERIODS[q.period];
  const heldDays = view.oldest === null ? 0 : Math.round((Date.parse(belgianDay(now)) - Date.parse(belgianDay(view.oldest))) / 86_400_000) + 1;
  const partial = days !== null && heldDays > 0 && heldDays < days ? `<p class="muted small">Only ${number(heldDays)} of the period&rsquo;s ${number(days)} days are stored so far.</p>` : '';

  const toggles = SPLITS.map((v) => `<button type="submit" name="split" value="${v}" aria-pressed="${v === q.split}">${SPLIT_LABELS[v]}</button>`).join('');
  const form = `<form class="filters" method="get" action="/cycle-time">
<input type="hidden" name="group" value="${q.group}">
${selectField('period', 'Merged', PERIOD_CHOICES, q.period, 'all')}
${selectField('size', 'Size', [['', 'Any size'], ...SIZES.map((s): [string, string] => [s.key, s.label])], q.size ?? '')}
${selectField('outcome', 'Rounds', OUTCOMES, q.outcome ?? '')}
${q.group === 'check' ? '' : `<div class="field"><span id="splitby">Split by</span><div class="toggles" role="group" aria-labelledby="splitby">${toggles}</div></div>`}
<input type="hidden" name="split" value="${q.split}">
<noscript><button type="submit">Apply</button></noscript>
</form>`;

  const tabs = bandTabs(GROUPS.map((g): [string, string, boolean] => [link({ group: g }), GROUP_LABELS[g], g === q.group]));
  return reportPage({ current: 'cycle-time', tabs, body: `${form}\n${partial}${content}`, style: EXTRA }, now);
}

const EXTRA = `
@media (max-width:640px){
  .filters{grid-template-columns:repeat(2,minmax(0,1fr))}
  .filters .field:nth-of-type(n+3){grid-column:1/-1}
  .toggles button{flex:1}
}
.up{color:var(--over-ink)}.down{color:var(--good)}
.scatter-well{display:flex;flex-direction:column;gap:10px;padding:14px 14px 16px}
.scatter-well svg{display:block;width:100%;max-width:340px;height:auto;margin:0 auto}
.scatter-well .note{border-top:0;padding-top:0}
.scatter-well .legend{justify-content:center}
.equal{stroke:var(--ink-faint);stroke-dasharray:4 4;stroke-width:1}
.median{stroke:var(--ink-strong);stroke-width:1.25}
.dot{fill-opacity:.75;stroke-width:1.25}
a:hover .dot,a:focus .dot{fill-opacity:1;stroke:var(--ink-strong)}
.key i.solid{width:16px;height:0;border-top:2px solid var(--ink-strong);border-radius:0;background:none}
.key i.dash{border-top-color:var(--ink-faint)}
.cut{fill:var(--ink-faint)}
.chart a rect:hover{opacity:.8}
.chart-note{margin:6px 4px 0;font-size:13px;color:var(--ink-faint)}
.tag{display:inline-block;padding:0 6px;border-radius:var(--radius-sm);background:color-mix(in srgb,var(--shade) 8%,transparent);color:var(--ink-soft);font-size:12px}
.tile-note .up,.tile-note .down{font-weight:600}
.table .first{min-width:300px}.table .split-cell{min-width:130px}
`;
