/**
 * The Design tab: the design alone, with no line from the code. The layers as boxes with their parts, one arrow for each
 * call the rules allow carrying only its number, and below the drawing the rules grouped by the layer they start from,
 * a card each with its mark, reason and source. The services page's Design tab draws the services and the calls allowed
 * between them the same way. The model in, one self-contained HTML file out; it reads nothing from the checkout.
 *
 * A rule is `agreed` once the engineer set it so in the rules file; otherwise it is a draft with the section of
 * docs/architecture.md its reason was read from, or a question where no reason is written.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { designFile, LOGICAL_FILE, renderNested, serviceTabs, servicesOf, specOf } from './logical.js';
import { linkPaths, linksFor } from './links.js';
import { servicesSpec } from './services.js';
import { crumbTrail, prose, SERVICES_DESIGN_FILE, SERVICES_TRAIL, switchNav, trailOf } from './shell.js';
import { isOpened } from './parts.js';
import { esc } from './svg.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** The name a layer goes by in a sentence: its title up to the colon. */
const shortTitle = (title) => title.split(':')[0];

/** Where a rule stands: `agreed`, a `question` where nothing is written or the engineer is asked, else a `drafted` reason. */
export function stateOf(entry) {
  if (entry?.agreed) return 'agreed';
  if (!entry || entry.question || !entry.reason) return 'question';
  return 'drafted';
}

/** The count line: how many rules, and how many of them stand in each way. */
export function countLine(entries) {
  const states = entries.map(stateOf);
  const count = (state) => states.filter((each) => each === state).length;
  return `${plural(entries.length, 'rule')}, ${count('agreed')} agreed, ${count('drafted')} drafted, ${plural(count('question'), 'question')}`;
}

/** One sentence naming every layer a start layer may call: "Clients call the API layer, and nothing else." */
export function callsSentence(from, targets) {
  const verb = /s$/i.test(from.trim().split(/\s+/).at(-1)) ? 'call' : 'calls';
  // A name ending in "layer" takes "the", as subject and as object.
  const named = (name, article) => (/\blayer$/i.test(name.trim()) ? `${article} ${name}` : name);
  const them = targets.map((target) => named(target, 'the'));
  const list = them.length === 1 ? them[0] : `${them.slice(0, -1).join(', ')} and ${them.at(-1)}`;
  return `${named(from, 'The')} ${verb} ${list}, and nothing else.`;
}

const MARKS = {
  agreed: '<span class="mark agreed">agreed</span>',
  drafted: '<span class="mark drafted">drafted, not agreed</span>',
  question: '<span class="mark question">question for you</span>',
};

function ruleBody(entry) {
  if (!entry || (!entry.reason && !entry.question)) return '<p class="why q">No reason found in docs/architecture.md.</p>';
  return `${entry.reason ? `<p class="why">${esc(entry.reason)}</p>` : ''}${entry.question ? `<p class="why q">${esc(entry.question)}</p>` : ''}${entry.source ? `<p class="src">From docs/architecture.md: ${esc(entry.source)}</p>` : ''}`;
}

/** A rule as a card; `n` is its number on the drawing, a dot where the drawing has no arrow for it. */
function ruleCard({ id, n, title, entry, lead = '', extra = '' }) {
  return `<div class="rule"${id ? ` id="${id}"` : ''}><div class="rule-h"><span class="num num-rule">${n ?? '·'}</span><b>${esc(title)}</b>${MARKS[stateOf(entry)]}</div>${lead ? `<p class="lead">${esc(lead)}</p>` : ''}${ruleBody(entry)}${extra}</div>`;
}

const CSS = `
.rule { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 10px 14px; margin: 8px 0; }
.rule:target { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent); }
.rule-h { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.mark { font: 600 11.5px var(--sans); border-radius: 9px; padding: 1px 8px; border: 1px solid var(--line); color: var(--ink-3); }
.mark.agreed { color: var(--green); border-color: var(--green); }
.mark.question { color: var(--accent); border-color: var(--accent); }
.rule .lead { margin: 6px 0 0; font-weight: 600; }
.rule .why { margin: 6px 0 0; color: var(--ink-1); }
.rule .why.q { color: var(--accent); }
.rule .src { margin: 4px 0 0; color: var(--ink-3); font-size: 12.5px; }
.num.num-rule { background: var(--ink-2); }
h3 { font-size: 14.5px; margin: 20px 0 4px; }
ul.plain { padding-left: 18px; } ul.plain li { margin: 3px 0; }
.nl-rule { stroke: var(--ink-2); stroke-width: 2; }
.nm-rule, .nl-num.nl-num-rule { fill: var(--ink-2); }
.count { font-weight: 600; }`;

const LEGEND = '<div class="legend"><span><i class="ln" style="border-top-width:2px"></i>An allowed call, numbered: its rule and reason are below</span><span><i class="ln" style="border-top-color:var(--accent);border-top-style:dashed"></i>How a caller reaches it</span></div>';

function page({ model, title, crumbs, tabs, standfirst, body, focus = '' }) {
  const links = linksFor(model.drawnFrom);
  const styles = `${readFileSync(path.join(here, 'styles.css'), 'utf8')}${readFileSync(path.join(here, 'logical.css'), 'utf8')}${CSS}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(title)} Design &middot; Cockpit</title>
<style>${styles}${focus}</style>
</head>
<body>
<div class="wrap wide">
<header class="masthead"><p class="crumbs">${crumbTrail(crumbs)}</p><h1>${esc(title)}</h1>${tabs}<p class="standfirst">${linkPaths(standfirst, links)}</p></header>
${linkPaths(body, links)}
</div>
</body>
</html>
`;
}

/** The rules grouped by the box they start from: one sentence, then a card for each. `rules` are `{ n, from, to, entry }`. */
function groupsOf(rules, nameOf) {
  return [...new Set(rules.map((rule) => rule.from))].map((from) => {
    const mine = rules.filter((rule) => rule.from === from);
    const cards = mine.map((rule) => ruleCard({ id: `rule-${rule.n}`, n: rule.n, title: `${nameOf(rule.from)} → ${nameOf(rule.to)}`, entry: rule.entry, lead: rule.text })).join('');
    return `<h3>${esc(callsSentence(nameOf(from), mine.map((rule) => nameOf(rule.to))))}</h3>${cards}`;
  }).join('');
}

const callersTable = (rows) => (rows.length
  ? `<div class="scroll"><table class="flows"><tr><th>Caller</th><th>Reaches</th><th>How</th></tr>${rows.map((row) => `<tr><td>${esc(row.who)}</td><td>${esc(row.at)}</td><td>${esc(row.how)}</td></tr>`).join('')}</table></div>`
  : '<p class="dim">None declared.</p>');

const notAllowedList = (texts) => `<ul class="plain">${texts.map((text) => `<li>${esc(text)}.</li>`).join('')}<li>Anything else the drawing does not draw.</li></ul>`;

/** @returns {string} a complete HTML document: one service's intended design */
export function renderDesignPage(model, service = {}) {
  const logical = service.logical ?? model.logical;
  const name = service.name ?? 'Cockpit';
  const links = linksFor(model.drawnFrom);
  const spec = specOf(logical, links);
  const { layerById, nameOf } = spec;
  const { reasons = {}, breaks = {}, rules: inside = [], accepted = [], callers = [] } = logical.design ?? {};
  const unruled = logical.unruled === true;
  const title = (id) => shortTitle(layerById.get(id).title);

  const calls = logical.mayCall.map(([from, to], at) => ({ n: at + 1, from, to, entry: reasons[`${from}>${to}`] }));
  const boxId = (layerId) => `L-${layerId}`;
  const lines = [
    ...calls.map((call) => ({ from: boxId(call.from), to: boxId(call.to), kind: 'rule', n: call.n, id: `rule-${call.n}`, href: `#rule-${call.n}`, title: `${call.n}. ${title(call.from)} may call ${title(call.to)}` })),
    ...callers.map((caller) => ({ from: caller.from, to: caller.to, declared: true, kind: 'decl', label: caller.how, toName: nameOf(caller.to), title: `${nameOf(caller.from)} → ${nameOf(caller.to)}: ${caller.how}` })),
  ];
  // A service the rules do not rule inside has no layers to draw: only how it is reached and what its rules say.
  const drawing = unruled ? null : renderNested({ label: `${name}: the intended design`, rows: spec.rows.map((row) => row.map((box) => ({ ...box, note: '' }))), side: spec.side && { ...spec.side, note: '' }, sideRow: spec.sideRow, lines, laneStart: 34 }, links);

  const all = [...calls.map((call) => call.entry), ...inside, ...accepted];
  const standfirst = `${service.intro ? `${prose(service.intro)} ` : ''}${unruled ? `The rules for ${esc(name)}: how it is reached and what it keeps to. Its layers are not ruled.` : `The layers ${esc(name)} is meant to have and the rules between them, with nothing from the code. Agree it here first; <a href="${esc(service.file ?? LOGICAL_FILE)}">Logical</a> then shows where the code departs from it.`} <b class="count">${esc(countLine(all))}</b>.`;

  const insideHtml = inside.length ? `<h2>Rules inside and across the layers</h2>${inside.map((rule) => ruleCard({ title: rule.rule, entry: rule })).join('')}` : '';
  const acceptedHtml = accepted.length
    ? accepted.map((each) => ruleCard({ title: `${nameOf(each.from)} → ${nameOf(each.to)}`, entry: each, extra: `<p class="src">Covers ${each.files.map((file) => `<code>${esc(file)}</code>`).join(', ')}</p>` })).join('')
    : '<p class="dim">None.</p>';

  const body = `${drawing ? `${LEGEND}<div class="diagram">${drawing.svg}</div>` : ''}
${calls.length ? `<h2>What each layer may call, and why</h2>${groupsOf(calls, title)}` : ''}${insideHtml}
${unruled ? '' : `<h2>What is not allowed</h2>${notAllowedList(Object.values(breaks))}`}
<h2>Accepted deviations</h2><p class="sectionnote">A call the rules above do not allow, accepted for the files named and no others.</p>${acceptedHtml}
<h2>How each caller reaches it</h2>${callersTable(callers.map((caller) => ({ who: nameOf(caller.from), at: nameOf(caller.to), how: caller.how })))}
<p class="sectionnote">Written by hand in ${links.file('docs/architecture.yml')}. A rule is agreed by a pull request that sets <code>agreed: true</code> on it.</p>`;

  const opened = isOpened(logical);
  return page({
    model,
    title: name,
    crumbs: [...trailOf(model), ...(opened ? [['Cockpit', designFile(LOGICAL_FILE)]] : []), [name]],
    tabs: serviceTabs(model, service, 'Design'),
    standfirst,
    body,
    focus: drawing?.focus ?? '',
  });
}

/** @returns {string} the services page's Design tab: the services and the calls allowed between them */
export function renderServicesDesignPage(model) {
  const links = linksFor(model.drawnFrom);
  const map = model.serviceMap;
  const { rows, side, nameOf, endOf } = servicesSpec(map, { opensOn: designFile, badges: false });
  const between = map.between ?? [];
  let next = 0;
  const rules = between.map((each) => ({ ...each, n: each.from && each.to ? ++next : null }));
  const called = rules.filter((rule) => rule.n !== null);
  const general = rules.filter((rule) => rule.n === null);

  const lines = [
    ...called.map((rule) => ({ from: endOf(rule.from), to: endOf(rule.to), kind: 'rule', n: rule.n, id: `rule-${rule.n}`, href: `#rule-${rule.n}`, title: `${rule.n}. ${nameOf.get(rule.from)} may call ${nameOf.get(rule.to)}` })),
    // How the people and tools outside reach a service: a service calling a service is a rule above, not a caller.
    ...map.calls.filter((call) => !nameOf.has(call.from)).map((call) => ({ from: endOf(call.from), to: endOf(call.to), kind: 'decl', declared: true, label: call.how, toName: nameOf.get(call.to), title: `${call.from} → ${call.to}: ${call.how}` })),
  ];
  const drawing = renderNested({ label: 'The services: the intended design', rows, side, sideRow: 1, lines, laneStart: 30, gap: 170 }, links);

  const clientName = new Map(map.clients.map((each) => [each.id, each.name]));
  const who = (id) => nameOf.get(id) ?? clientName.get(id) ?? id;
  const groups = groupsOf(called.map((rule) => ({ n: rule.n, from: rule.from, to: rule.to, entry: rule, text: rule.rule })), who);
  const generalHtml = general.length ? `<h3>Between every pair of services</h3>${general.map((rule) => ruleCard({ title: rule.rule, entry: rule })).join('')}` : '';

  const body = `${LEGEND}<div class="diagram">${drawing.svg}</div>
<h2>What each service may call, and why</h2>${groups}${generalHtml}
<h2>What is not allowed</h2>${notAllowedList([])}
<h2>How each caller reaches the services</h2>${callersTable(map.calls.filter((call) => !nameOf.has(call.from)).map((call) => ({ who: who(call.from), at: who(call.to), how: call.how })))}
<p class="sectionnote">Written by hand in ${links.file('docs/architecture.yml')}. A rule is agreed by a pull request that sets <code>agreed: true</code> on it.</p>`;
  return page({
    model,
    title: 'Services',
    crumbs: [SERVICES_TRAIL[0], ['Services']],
    tabs: switchNav([['Design', SERVICES_DESIGN_FILE, true], ['Logical', 'services.html', false]]),
    standfirst: `The services and the calls allowed between them, with nothing from the code. <a href="services.html">Logical</a> shows what the code does. <b class="count">${esc(countLine(rules))}</b>.`,
    body,
    focus: drawing.focus,
  });
}

/** @returns {Record<string, string>} the Design tab of every service with a page, and of the services page when the report has one */
export function renderDesignPages(model) {
  return {
    ...(model.serviceMap ? { [SERVICES_DESIGN_FILE]: renderServicesDesignPage(model) } : {}),
    ...Object.fromEntries(servicesOf(model).map((service) => [designFile(service.file), renderDesignPage(model, service)])),
  };
}
