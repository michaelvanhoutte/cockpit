import { addDays, belgianDay, formatDateTime, formatDay, startOfDay } from './belgium';
import type { CycleTimeView } from './cycle-time-store';
import { esc, questionOf, selectField } from './look';
import { dollars, number, REPOSITORY } from './page';
import { BLUE, GREY, RED, slot, VIOLET } from './palette';
import { STRIP_SCRIPT } from './cycle-time-strip';
import { LEAD_MORE, WHAT } from './cycle-time-explain';
import { EXPLAIN_SCRIPT, EXPLAIN_STYLE, explain, lead } from './explain';
import { bandTabs, outLink, reportPage, section, tile } from './report';
import {
  buckets,
  CHECKS,
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
  outline,
  outlineFigures,
  OUTLINE_SLOTS,
  PHASES,
  redRounds,
  SIZES,
  sizeOf,
  startToMerge,
  sum,
  values,
  type CycleTimeQuery,
  type OutlineRow,
  type PhaseKey,
  type Pull,
} from './cycle-time-report';

/**
 * The colour of each phase (src/palette.ts), in stacking order: the slots in
 * turn, blue beside the grey Away, which stacks last. A part of a phase is
 * drawn in its phase's colour, and grey where it is not one of the named ones.
 */
const COLOUR_OF_PHASE: Record<PhaseKey, string> = { writing: slot(1), local: slot(2), ci: slot(3), waiting: BLUE, away: GREY };
const COLOURED = PHASES.map((s) => ({ ...s, colour: COLOUR_OF_PHASE[s.key] }));
const colourOfPhase = (key: PhaseKey) => COLOUR_OF_PHASE[key];
/** An outline row's colour: its phase's, or grey where it is not one of the named parts. */
const colourOfSlot = (s: { phase: PhaseKey; other: boolean }) => (s.other ? GREY : colourOfPhase(s.phase));
/** What the strip's script lays a row out from, once a page: each slot's name, whether it is a part, whether it is grey, and its colour. */
const SLOTS_JSON = JSON.stringify(OUTLINE_SLOTS.map((s) => [s.label, s.part ? 1 : 0, s.other ? 1 : 0, colourOfSlot(s)])).replace(/</g, '\\u003c');

/** The Check tab's colour for each check, in the order CI runs them (the slots in turn, blue beside the grey), and grey for any other. */
const CHECK_COLOURS = [slot(1), slot(2), slot(3), slot(4), BLUE];
const colourOfCheck = (name: string) => CHECK_COLOURS[CHECKS.indexOf(name)] ?? GREY;

const unrecordedNote = (n: number) =>
  n === 0 ? '' : ` ${plural(n, 'pull request')} here ${n === 1 ? 'carries' : 'carry'} no session record: ${n === 1 ? 'its' : 'their'} writing starts at the first commit and ${n === 1 ? 'its' : 'their'} local checks are not recorded, which is not zero.`;
const unsplitNote = (n: number) => (n === 0 ? '' : ` ${plural(n, 'pull request')} here ${n === 1 ? 'was' : 'were'} stored without the kinds of local check, so ${n === 1 ? 'its' : 'their'} local minutes are drawn as Not split by kind.`);

/** The cycle time page: the same pull requests whatever the tab, narrowed by the filters, with the tiles and overview panels only on the first. */
export function renderCycleTime(q: CycleTimeQuery, view: CycleTimeView, repository: string | undefined, now: number): string {
  const repo = repository !== undefined && REPOSITORY.test(repository) ? repository : null;
  const { list, previous } = filtered(view.pulls, q, now);
  const cost = (p: Pull) => costOf(view.costs, p);
  const issueOf = (p: Pull) => view.costs.get(p.number)?.issue ?? null;
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
${tile('Start to merge', median === null ? '—' : hm(median), median === null ? 'no pull request merged' : `median of ${plural(list.length, 'pull request')} · p95 ${hm(p95!)}${compare}`, '', explain('t-start', 'Start to merge', WHAT.startToMerge))}
${tile('In the harness', share === null ? '—' : `${Math.round(share * 100)}%`, ratio === null ? 'no pull request with a session record' : `of writing plus harness · median ${ratio.toFixed(1)}× the writing`, '', explain('t-harness', 'In the harness', WHAT.inHarness))}
${tile('CI rounds', number(rounds), list.length ? `${(rounds / list.length).toFixed(1)} a pull request · ${plural(red, 'red round')} · ${plural(flukes, 'fluke')}` : 'none', '', explain('t-rounds', 'CI rounds', WHAT.rounds))}
${tile('Claude Code cost', priced.length ? dollars(spent) : '—', priced.length ? `${dollars(spent / priced.length)} a pull request · ${number(priced.length)} of ${number(list.length)} priced` : 'none priced', '', explain('t-cost', 'Claude Code cost', WHAT.cost))}
</div>`;
  }

  /** One row of the outline: a name, a bar on the start-to-merge scale (a part's inside its phase's band), its minutes and its share. */
  function outlineRow(r: OutlineRow): string {
    const colour = colourOfSlot(r);
    const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
    const band = r.stretch ? `<div class="band" style="left:${pct(r.stretch.left)};width:${pct(r.stretch.width)}"></div>` : '';
    return `<li class="o-row ${r.part ? 'o-pt' : 'o-ph'}"><span class="nm">${esc(r.label)}</span><div class="tr">${band}<div class="b" style="left:${pct(r.left)};width:${pct(r.width)};background:${colour}" title="${esc(r.label)} ${hm(r.ms)}"></div></div><span class="am">${hm(r.ms)}</span><span class="sh">${Math.round(r.share * 100)}%</span></li>`;
  }

  /** Where the time went: every phase on one start-to-merge scale, with Local checks and CI rounds opened into their parts. */
  function where(): string {
    const o = outline(list);
    const noRecord = unrecordedNote(list.filter((p) => !p.balance).length) + unsplitNote(o.unsplit);
    return section(
      'where-it-went',
      `Where the ${hm(o.total)} went`,
      plural(list.length, 'pull request'),
      `<div class="well where">
<ul class="outline" aria-label="Phases of start to merge, with local checks and CI rounds opened into their parts">${o.rows.map(outlineRow).join('')}</ul>${noRecord ? `\n<p class="note">${noRecord.trim()}</p>` : ''}
</div>`,
      'panel wide',
      explain('where', 'Where the time went', WHAT.where),
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
    const colour = (rounds: number) => (rounds >= 3 ? RED : VIOLET);
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
      [VIOLET, 'a pull request'],
      [RED, '3 rounds or more'],
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
      explain('scatter', 'Writing against the harness', WHAT.scatter),
    );
  }

  /** A stacked bar per pull request at the moment it merged, so a busy day looks busy and a quiet one quiet. */
  function overTime(): string {
    const series = COLOURED;
    const days = PERIODS[q.period];
    const firstDay = days === null ? belgianDay(Math.min(...list.map(mergedMs), now)) : addDays(belgianDay(now), -(days - 1));
    const t0 = startOfDay(firstDay);
    const t1 = startOfDay(addDays(belgianDay(now), 1));
    const { width, height, left, right, top, bottom } = { width: 1000, height: 260, left: 64, right: 12, top: 12, bottom: 30 };
    const plotW = width - left - right;
    const plotH = height - top - bottom;
    const stacks = list.map((p) => {
      const v = values(p);
      return { p, v, total: sum(series.map((s) => v[s.key] ?? 0)) };
    });
    const tallest = Math.max(60_000, ...stacks.map((s) => s.total));
    const cap = Math.min(tallest, 4 * 3_600_000);
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
            return `<rect x="${(cx - barW / 2).toFixed(1)}" y="${y1.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0.5, y0 - y1).toFixed(1)}" fill="${s.colour}"><title>#${p.number} ${esc(p.title)} · ${esc(s.label)} ${hm(ms)} · start to merge ${hm(p.time.totalMs)}</title></rect>`;
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
      'Start to merge, each pull request as it merged',
      `<span class="legend">${legend}</span>`,
      `<div class="well chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Start to merge per pull request, by when it merged">${grid}${ticks}${bars}</svg><p class="chart-note">A bar per pull request, at the moment it merged${cutNote}. A bar opens its Sessions.</p></div>`,
      'panel',
      explain('over-time', 'Start to merge, each pull request as it merged', WHAT.overTime),
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
    const series = COLOURED;
    const all = buckets(group, list, issueOf);
    const info = explain(`t-${group}`, group === 'day' ? 'By day merged' : `By ${GROUP_LABELS[group].toLowerCase()}`, WHAT[group]);
    if (all.length === 0) return section('cycle-table', GROUP_LABELS[group], '', '<p class="well empty">Nothing in this period. No merged pull request matches these filters.</p>', 'panel wide', info);
    const perPull = group === 'pr';
    const summed = group === 'issue';
    /** A row's minutes: a pull request's own, an issue's added up, a day's or a size's per pull request on average. */
    const per = (pulls: Pull[]) => (perPull || summed ? 1 : pulls.length);
    const fold = (pulls: Pull[], f: (p: Pull) => number) => sum(pulls.map(f)) / per(pulls);
    const rows = all.map((b) => ({ b, cells: series.map((s) => fold(b.pulls, (p) => values(p)[s.key] ?? 0)), total: fold(b.pulls, (p) => p.time.totalMs) }));
    // Scaled to the 90th percentile row, so one pull request away for a night does not flatten every other bar.
    const max = Math.max(1, quantile(rows.map((r) => sum(r.cells)), 0.9) ?? 1);
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
        // No column per phase: hovering the bar names each phase's time, on the row's own measure.
        const named = series.flatMap((s, i) => (cells[i]! > 0 ? [`${s.label} ${hm(cells[i]!)}`] : []));
        const hover = named.length ? ` title="${esc(named.join(' · '))}"` : '';
        const rounds = sum(b.pulls.map((p) => p.rounds.length));
        const red = sum(b.pulls.map(redRounds));
        const priced = b.pulls.filter((p) => cost(p) !== null);
        const spent = sum(priced.map((p) => cost(p)!.micros));
        const unpriced = sum(priced.map((p) => cost(p)!.unpricedRequests));
        const notes = [priced.length < b.pulls.length && !perPull ? `${priced.length} of ${b.pulls.length} priced` : '', unpriced ? `${plural(unpriced, 'request')} not priced` : ''].filter(Boolean);
        const costCell = priced.length
          ? `${perPull ? `<a href="/pr/${one.number}">${dollars(spent)}</a>` : dollars(spent)}${notes.length ? `<div class="sub">${notes.join(' · ')}</div>` : ''}`
          : '<span class="faint" title="The Monitor holds no Claude Code request for it">—</span>';
        // The figures of the row's own outline, on the table's measure, in milliseconds written in base 36 to keep the row short: opening it draws the strip from them, with no request.
        const figures = outlineFigures(b.pulls, per(b.pulls)).map((n) => (Math.round(n) > 0 ? Math.round(n).toString(36) : ''));
        while (figures.at(-1) === '') figures.pop();
        // A row with no minutes at all has no outline to draw, so it is not offered to open.
        return `<tr${figures.length ? ` data-figures="${figures.join(',')}"` : ''}><td class="first">${label}${sub ? `<div class="sub">${sub}</div>` : ''}</td>${perPull ? '' : `<td class="num faint-num">${number(b.pulls.length)}</td>`}<td class="split-cell"${hover}><div class="split">${bar}</div></td><td class="num total">${hm(total)}</td><td class="num">${number(rounds)}${red ? ` <span class="up">· ${red} red</span>` : ''}</td><td class="num total">${costCell}</td></tr>`;
      })
      .join('\n');
    const how = perPull ? 'newest first' : summed ? 'its pull requests added up · newest first' : group === 'day' ? 'a pull request on average · newest first' : 'a pull request on average';
    const noun = group === 'day' ? 'day' : group === 'size' ? 'size' : group === 'issue' ? 'issue' : 'pull request';
    return section(
      'cycle-table',
      `By ${group === 'day' ? 'day merged' : GROUP_LABELS[group].toLowerCase()}`,
      `${plural(all.length, noun)} · ${how}`,
      `<div class="well table"><table class="openable">
<thead><tr><th scope="col">${group === 'day' ? 'Day merged' : GROUP_LABELS[group]}</th>${perPull ? '' : '<th scope="col" class="num">Pull requests</th>'}<th scope="col" class="split-head">Split</th><th scope="col" class="num">Start to merge</th><th scope="col" class="num">Rounds</th><th scope="col" class="num">Claude Code</th></tr></thead>
<tbody>${body}</tbody></table></div>
<script type="application/json" id="outline-slots">${SLOTS_JSON}</script>
<script>${STRIP_SCRIPT}</script>`,
      'panel wide',
      info,
    );
  }

  /** Which check held the rounds up. */
  function checks(): string {
    const { rows, rounds } = checkRows(list);
    const info = explain('t-check', 'By check', WHAT.check);
    if (list.length === 0) return section('by-check', 'By check', '', '<p class="well empty">Nothing in this period. No merged pull request matches these filters.</p>', 'panel wide', info);
    if (rows.length === 0) return section('by-check', 'By check', '', '<p class="well empty">No CI round in these pull requests.</p>', 'panel wide', info);
    const colourOf = colourOfCheck;
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
      info,
    );
  }

  // The default tab is the overview; every other tab goes straight from the filters to its own table.
  const overview = q.group === 'day' ? `${stats()}\n<div class="row">${where()}${scatter()}</div>\n${list.length ? overTime() : ''}\n` : '';
  const content = `${overview}${q.group === 'check' ? checks() : table(q.group)}`;

  const days = PERIODS[q.period];
  const heldDays = view.oldest === null ? 0 : Math.round((Date.parse(belgianDay(now)) - Date.parse(belgianDay(view.oldest))) / 86_400_000) + 1;
  const partial = days !== null && heldDays > 0 && heldDays < days ? `<p class="muted small">Only ${number(heldDays)} of the period&rsquo;s ${number(days)} days are stored so far.</p>` : '';

  const form = `<form class="filters" method="get" action="/cycle-time">
<input type="hidden" name="group" value="${q.group}">
${selectField('period', 'Merged', PERIOD_CHOICES, q.period, 'all')}
${selectField('size', 'Size', [['', 'Any size'], ...SIZES.map((s): [string, string] => [s.key, s.label])], q.size ?? '')}
${selectField('outcome', 'Rounds', OUTCOMES, q.outcome ?? '')}
<noscript><button type="submit">Apply</button></noscript>
</form>`;

  const tabs = bandTabs(GROUPS.map((g): [string, string, boolean] => [link({ group: g }), GROUP_LABELS[g], g === q.group]));
  // The page opens with the question its top tab names and the words a newcomer will not know, on every tab.
  const pageLead = lead(questionOf('cycle-time'), LEAD_MORE);
  return reportPage({ current: 'cycle-time', tabs, body: `${pageLead}\n${form}\n${partial}${content}\n${EXPLAIN_SCRIPT}`, style: EXTRA + EXPLAIN_STYLE }, now);
}

const EXTRA = `
@media (max-width:640px){
  .filters{grid-template-columns:repeat(2,minmax(0,1fr))}
  .filters .field:nth-of-type(n+3){grid-column:1/-1}
}
.up{color:var(--over-ink)}.down{color:var(--good)}
.outline{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.o-row{display:grid;grid-template-columns:210px minmax(0,1fr) 80px 44px;align-items:center;gap:12px;height:28px}
.o-row .nm{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.o-row .am{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.o-row .sh{text-align:right;color:var(--ink-faint);font-size:13px;font-variant-numeric:tabular-nums}
.o-row .tr{position:relative;height:12px;border-radius:3px;background:color-mix(in srgb,var(--shade) 7%,transparent)}
.o-row .band{position:absolute;top:-8px;bottom:-8px;background:var(--accent-tint)}
.o-row .b{position:absolute;top:0;bottom:0;min-width:2px;border-radius:3px}
.o-ph .nm,.o-ph .am{color:var(--ink-strong);font-weight:500}
.o-pt .nm,.o-pt .am{color:var(--ink);font-size:13px}
.o-pt .nm{padding-left:20px}
.o-pt .b{top:2px;bottom:2px;border-radius:2px}
@media (max-width:640px){
  .o-row{grid-template-columns:minmax(0,1fr) auto 40px;grid-template-areas:"nm am sh" "tr tr tr";height:auto;gap:3px 10px;padding:5px 0}
  .o-row .nm{grid-area:nm}.o-row .am{grid-area:am}.o-row .sh{grid-area:sh}.o-row .tr{grid-area:tr}
  .o-row .band{top:-3px;bottom:-3px}
}
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
.table .first{min-width:300px}
.openable{--open-tint:color-mix(in srgb,var(--accent) 8%,var(--well))}
/* The table can be wider than its panel and scroll inside it; a strip stays as wide as the panel and keeps to the visible edge, so its minutes are never out of sight. */
.well.table:has(>.openable){container-type:inline-size}
.strip{position:sticky;left:0;width:calc(100cqw - 58px)}
.open-cell{width:28px;padding-right:0!important}
.chev{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;margin:-3px 0;padding:0;border:0;border-radius:6px;background:none;color:var(--ink-soft);font:inherit;font-size:14px;cursor:pointer}
.chev:hover{background:color-mix(in srgb,var(--shade) 8%,transparent);color:var(--ink-strong)}
.openable tr[data-figures]{cursor:pointer}
.openable tr.open>td{background:var(--open-tint);border-bottom-color:transparent}
.openable tr.detail:hover{background:none}
.openable tr.detail>td{padding:4px 10px 16px 48px;background:var(--open-tint)}
.strip .outline{gap:1px}
.strip .o-row .tr{background:var(--field)}
@media (min-width:641px){
  .strip .o-row{grid-template-columns:200px minmax(0,1fr) 70px 44px;height:24px}
  .strip .o-ph .nm,.strip .o-ph .am{font-size:13px}
  .strip .o-pt .nm,.strip .o-pt .am,.strip .o-row .sh{font-size:12px}
  .strip .o-row .tr{height:10px}
  .strip .o-row .band{top:-7px;bottom:-7px}
}
@media (max-width:640px){
  .openable tr.detail>td{padding:4px 10px 12px 16px}
  .strip{width:calc(100cqw - 26px)}
}
`;
