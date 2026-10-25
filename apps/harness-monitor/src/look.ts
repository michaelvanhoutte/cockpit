import { APPEARANCE_BOOT } from './appearance';
import { belgianDay, formatDateTime } from './belgium';

/**
 * Cockpit's look on the Monitor's pages: the stylesheet, the top bar, the band,
 * the section heading and the page around them. The Monitor imports nothing
 * from Cockpit, so the values below are copied by value from
 * docs/design-system.md and apps/web/src/styles.css, not shared, except the
 * series colours (`--series-*`), the Monitor's own chart palette (src/palette.ts).
 */

/** Names, titles and logins come from outside, so they are escaped. */
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Inter, served by the Monitor itself from public/fonts (a static asset, cached
 * for good by public/_headers) so no page reaches an outside host for it. The
 * name carries the version: a new font is a new address, never a changed file.
 */
export const FONT_URL = '/fonts/inter-5.3.0-latin-wght.woff2';

/** The mark: four rounded squares, the fourth in the default theme's violet lifted for the chrome. */
const LOGO = `<svg aria-hidden="true" viewBox="0 0 32 32" class="logo"><rect x="3" y="3" width="12" height="12" rx="2.5" fill="var(--chrome-ink)"/><rect x="17" y="3" width="12" height="12" rx="2.5" fill="var(--chrome-ink)"/><rect x="3" y="17" width="12" height="12" rx="2.5" fill="var(--chrome-ink)"/><rect x="17" y="17" width="12" height="12" rx="2.5" fill="var(--logo-dot)"/></svg>`;

/**
 * Every page the top bar lists, in tab order, with the question it answers: the
 * tab names it on pointing, and the page may open with it. A new page is a line
 * here and its own route.
 */
export const PAGES = [
  { name: 'costs', href: '/', label: 'Claude Code costs', question: 'What does building this app with Claude Code cost, and where does the money go?' },
  { name: 'claude-calls', href: '/claude-calls', label: 'Cockpit&rsquo;s Claude calls', question: 'What do the app&rsquo;s own AI features cost to run?' },
  { name: 'cycle-time', href: '/cycle-time', label: 'Cycle time', question: 'How long does a change take to land, and how much of that is waiting on checks rather than writing?' },
  { name: 'selection', href: '/selection', label: 'Test selection', question: 'Does CI run only the tests a change can affect?' },
  { name: 'tests', href: '/tests', label: 'Tests', question: 'What do the tests cover, and at which level?' },
  { name: 'stability', href: '/stability', label: 'CI stability', question: 'How often do the automated checks fail, and which ones?' },
] as const;
export type PageName = (typeof PAGES)[number]['name'];
/** The question a page answers. */
export const questionOf = (name: PageName) => PAGES.find((p) => p.name === name)!.question;

/**
 * A section heading: the strip Cockpit draws over a panel, with an optional note
 * at its right. An (i) (`info`, src/explain.ts) sits beside the heading, not in
 * it, so the section stays named by its title alone.
 */
export const band = (title: string, aside = '', id = '', info = '') => {
  const heading = `<h2${id === '' ? '' : ` id="${id}"`}>${title}</h2>`;
  return `<div class="section-band">${info === '' ? heading : `<div class="heading">${heading}${info}</div>`}${aside === '' ? '' : `<span class="aside">${aside}</span>`}</div>`;
};

/** A control that holds a value wears `data-set`, as Cockpit's filters do. */
export function selectField(id: string, label: string, options: [value: string, text: string][], current: string, resting = ''): string {
  const opts = options
    .map(([value, text]) => `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(text)}</option>`)
    .join('');
  return `<div class="field"><label for="${id}">${label}</label><select id="${id}" name="${id}" onchange="this.form.submit()"${current === resting ? '' : ' data-set'}>${opts}</select></div>`;
}

/** A select inside the sentence: its name read by assistive technology, its value shown as a word of the sentence. A filter that holds a value wears `data-set`. */
export function inline(name: string, label: string, options: [value: string, text: string, off?: boolean][], current: string, resting: string | null = null): string {
  const opts = options.map(([v, t, off]) => `<option value="${esc(v)}"${v === current ? ' selected' : ''}${off ? ' disabled' : ''}>${esc(t)}</option>`).join('');
  // New rows start in their own order, so choosing them leaves the form's sort behind; every other choice keeps it.
  const leave = name === 'group' ? 'if(this.form.elements.sort)this.form.elements.sort.disabled=true;' : '';
  return `<select name="${name}" aria-label="${label}" onchange="${leave}this.form.submit()"${resting !== null && current !== resting ? ' data-set' : ''}>${opts}</select>`;
}

/**
 * A page's controls as one sentence: the words and selects, then the filters
 * after "Only" and any buttons. A filter passed as '' is not offered; `hidden`
 * carries what the form keeps without showing it.
 */
export function sentenceForm(action: string, sentence: string, only: string[], extra: string[] = [], hidden = ''): string {
  const filters = only.filter((f) => f !== '');
  const row = filters.length || extra.length ? `<div class="only">${filters.length ? `<span>Only</span>\n${filters.join('\n')}` : ''}\n${extra.join('\n')}</div>` : '';
  return `<form class="sentence-form" method="get" action="${action}">
<p class="sentence">${sentence}</p>
${row}
${hidden}
<noscript><button type="submit">Apply</button></noscript>
</form>`;
}

/**
 * The appearance select, at the right of the top bar. No option is selected
 * here: every viewer is sent the same page, so the script in the head sets the
 * select from the choice this browser remembers (src/appearance.ts), and
 * `autocomplete="off"` keeps the browser from restoring an older value over it.
 */
const APPEARANCE_SELECT = `<span class="appearance"><select id="appearance" aria-label="Appearance" autocomplete="off" onchange="monitorAppearance.choose(this.value)"><option value="">Match device</option><option value="light">Light</option><option value="dark">Dark</option></select></span>
<script>monitorAppearance.show()</script>`;

/** The top bar: the mark, the name, one tab per page, when the figures were read and the appearance. */
function chrome(current: PageName, now: number): string {
  return `<header class="topbar">
<a class="brand" href="/">${LOGO}<span>Harness Monitor</span></a>
<nav class="pages" aria-label="Pages">${PAGES.map((p) => `<a href="${p.href}" title="${p.question}"${p.name === current ? ' aria-current="page"' : ''}>${p.label}</a>`).join('')}</nav>
<span class="status">Updated ${formatDateTime(now)} · public, read-only</span>
${APPEARANCE_SELECT}
</header>`;
}

/**
 * What a page is drawn with: which tab is current, what its band carries, the
 * page itself, and any stylesheet it adds to the shared one. The band carries
 * `controls`, pinned to the top as the page scrolls, or nothing: a bare strip,
 * so the page's tab still runs into it.
 */
export function shell(page: { current: PageName; controls?: string; body: string; style?: string }, now: number): string {
  const strip = page.controls !== undefined ? `<div class="band band-controls">${page.controls}</div>` : '<div class="band"></div>';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Harness Monitor</title>
<script>${APPEARANCE_BOOT}</script>
<link rel="preload" href="${FONT_URL}" as="font" type="font/woff2" crossorigin>
<style>${STYLE}${page.style ?? ''}</style>
</head><body>
${chrome(page.current, now)}
${strip}
<main>
${page.body}
</main>
<footer>© ${belgianDay(now).slice(0, 4)} Conselit · <a href="https://www.conselit.be" target="_blank" rel="noopener noreferrer">conselit.be</a></footer>
</body></html>`;
}

/**
 * A line chart's key: a swatch and a name, or the total's dashed one when
 * `colour` is null. A series' key can be focused, so pointing at it or tabbing
 * to it picks its line out (HIGHLIGHT); the total's cannot, since the total
 * never fades.
 */
export const lineKey = (label: string, colour: string | null) =>
  colour === null
    ? `<span class="key"><i class="dash" aria-hidden="true"></i>${label}</span>`
    : `<span class="key" tabindex="0"><i style="background:${colour}" aria-hidden="true"></i>${label}</span>`;

/**
 * Picking a line out of a line chart, with no script: a chart is the innermost
 * `.panel` or `.trend` holding a `.legend` of keys and a `.lines` of groups, one
 * per key in the same order. Pointing at or focusing a series' key, or pointing
 * at its line, fades every other line but the total (`data-line=total`).
 */
const LINE_CHART = ':is(.panel,.trend):not(:has(.panel,.trend))';
const HIGHLIGHT = Array.from({ length: 16 }, (_, i) => i + 1)
  .map(
    (n) =>
      `${LINE_CHART}:has(.legend .key[tabindex]:nth-child(${n}):is(:hover,:focus),.lines>g:nth-child(${n}):not([data-line=total]):hover) .lines>g:not(:nth-child(${n})):not([data-line=total]){opacity:.15}`,
  )
  .join('\n');

/** The dark tokens: applied under the device's dark scheme unless Light is chosen, and whenever Dark is. */
const DARK = `
  --ground:#23242a;--surface:#24252b;--field:#141519;--well:#141418;
  --ink-strong:#e4e5ea;--ink:#c2c5cd;--ink-soft:#9a9eaa;--ink-faint:#8a8e9a;--shade:#e4e5ea;
  --accent-deep:#b3abdb;--accent-tint:color-mix(in srgb,#6f62b5 22%,#23242a);
  --series-1:#6c48d1;--series-2:#ea691f;--series-3:#b91a6f;--series-4:#01aaa2;--series-5:#895f11;--series-6:#408ffe;--series-7:#6a6e1a;--series-8:#9a5ca1;--series-grey:#80838d;
  --due:#8f82d8;--due-soft:#4a3519;--due-ink:#e8c08a;--over-ink:#e0867f;--good:#4ad6a0;
  --shadow-panel:0 0 0 1px rgb(255 255 255 / .06),0 1px 2px rgb(0 0 0 / .3);
  --well-edge:inset 0 2px 3px -1px rgb(0 0 0 / .5),0 0 0 1px rgb(255 255 255 / .04);
  color-scheme:dark;
`;
const DARK_CHEVRON = `background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23c2c5cd' stroke-width='1.5'/%3E%3C/svg%3E")`;

/** Cockpit's tokens (docs/design-system.md), copied by value: the Monitor shares no code with Cockpit. */
export const STYLE = `
@font-face{font-family:'Inter Variable';font-style:normal;font-display:swap;font-weight:100 900;src:url(${FONT_URL}) format('woff2-variations')}
:root{
  --ground:#e2e2df;--surface:#f4f5fb;--field:#fff;--well:color-mix(in srgb,var(--ground) 40%,#fff);
  --ink-strong:#16181d;--ink:#3a3f4b;--ink-soft:#555b68;--ink-faint:#5a5f6d;--shade:#16181d;
  --graphite-top:#2d2e35;--graphite-bottom:#16181d;--chrome-ink:#f2f1f8;--chrome-ink-soft:#a5a3b5;
  --accent:#6f62b5;--accent-deep:#5d5294;--accent-soft:#b5abfc;--accent-tint:#e7e5fe;--on-accent:#fff;--bar:#594e91;--logo-dot:#9a8fd6;
  --series-1:#562ab4;--series-2:#eb6200;--series-3:#ab1f68;--series-4:#169b95;--series-5:#7f5704;--series-6:#257ff6;--series-7:#868b3d;--series-8:#7c2f85;--series-grey:#6e717a;
  --due:#8579c4;--due-soft:#f1dcc0;--due-ink:#6b4515;--over:#bf5d55;--over-ink:#9d4d46;--good:#0b7a55;
  --shadow-panel:0 0 0 1px color-mix(in srgb,var(--accent) 14%,#d3d6e2),0 1px 2px rgb(22 24 29 / .05);
  --well-edge:inset 0 2px 3px -1px rgb(22 24 29 / .12);
  --radius-sm:4px;--radius-md:10px;--radius-lg:14px;
  color-scheme:light;
}
@media (prefers-color-scheme:dark){:root:not([data-appearance=light]){${DARK}}}
:root[data-appearance=dark]{${DARK}}
*{box-sizing:border-box}
html{background:var(--ground)}
body{margin:0;background:var(--ground);color:var(--ink);font:15px/1.55 'Inter Variable',Inter,system-ui,sans-serif;font-feature-settings:'cv11','ss01';-webkit-font-smoothing:antialiased}
a{color:var(--accent-deep);text-decoration-color:color-mix(in srgb,currentColor 35%,transparent);text-underline-offset:2px}
a:hover{text-decoration-color:currentColor}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:var(--radius-sm)}
h1,h2,h3,p{margin:0}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.muted{color:var(--ink-faint)}.small{font-size:13px}.nowrap{white-space:nowrap}.mono{font-variant-numeric:tabular-nums}.scroll{overflow-x:auto}

/* Top bar and band */
.topbar{display:flex;align-items:center;gap:8px 20px;flex-wrap:wrap;padding:10px 20px 0;background:linear-gradient(var(--graphite-top),var(--graphite-bottom));color:var(--chrome-ink);border-top:3px solid var(--accent)}
.brand{display:flex;align-items:center;gap:10px;color:var(--chrome-ink);text-decoration:none;font-weight:600;font-size:15px;padding-bottom:10px}
.logo{width:24px;height:24px;flex-shrink:0}
.pages{display:flex;gap:2px;align-self:flex-end}
.pages a{padding:9px 18px 10px;border-radius:var(--radius-md) var(--radius-md) 0 0;color:var(--chrome-ink-soft);text-decoration:none;font-size:16px;font-weight:500}
.pages a:hover{color:var(--chrome-ink);background:rgb(255 255 255 / .06)}
.pages a[aria-current=page]{background:var(--bar);color:var(--chrome-ink)}
.status{margin-left:auto;color:var(--chrome-ink-soft);font-size:12px;padding-bottom:10px}
.appearance{padding-bottom:10px}.appearance select{height:28px;font-size:12px;padding:0 26px 0 8px;background-position:right 8px center}
.band{background:var(--bar);padding:8px 20px 0}

/* A page's sentence, on the band and pinned */
.band-controls{position:sticky;top:0;z-index:5;padding:12px 20px 14px;box-shadow:0 2px 6px rgb(22 24 29 / .18)}
.sentence-form{max-width:1280px;margin:0 auto;display:flex;flex-direction:column;gap:10px}
.sentence{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;font-size:18px;color:var(--chrome-ink)}
.sentence select{height:40px;font-size:17px;font-weight:600}
.only{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.only>span{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--chrome-ink-soft);margin-right:4px}
.only select{height:34px;font-size:13px}.only .button{height:34px}
main{max-width:1320px;margin:0 auto;padding:20px 20px 40px;display:flex;flex-direction:column;gap:20px}

/* Filters */
.filters{display:flex;flex-wrap:wrap;align-items:flex-end;gap:12px 16px}
.field{display:flex;flex-direction:column;gap:4px}
.field>span,.field>label{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-faint)}
select{height:38px;padding:0 32px 0 12px;font:inherit;font-size:14px;color:var(--ink-strong);background:var(--field) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%235a5f6d' stroke-width='1.5'/%3E%3C/svg%3E") no-repeat right 12px center;border:1px solid color-mix(in srgb,var(--shade) 18%,transparent);border-radius:var(--radius-md);appearance:none;box-shadow:inset 0 1px 2px rgb(22 24 29 / .06);cursor:pointer}
@media (prefers-color-scheme:dark){:root:not([data-appearance=light]) select{${DARK_CHEVRON}}}
:root[data-appearance=dark] select{${DARK_CHEVRON}}
select[data-set]{border:2px solid var(--accent);padding-left:11px}
.button{margin-left:auto;display:inline-flex;align-items:center;height:38px;padding:0 16px;border-radius:var(--radius-md);background:var(--surface);box-shadow:var(--shadow-panel);color:var(--ink-strong);font-size:14px;font-weight:500;text-decoration:none}
.button:hover{background:var(--field)}
noscript button{height:38px;padding:0 16px;font:inherit}

/* Panels: a section heading over a well */
.panel{display:flex;flex-direction:column;min-width:0;padding:0 4px 4px;border:1px dotted color-mix(in srgb,var(--shade) 28%,transparent);border-radius:var(--radius-sm)}
.section-band{display:flex;align-items:center;flex-wrap:wrap;gap:4px 16px;padding:11px 10px 10px}
.section-band h2{font-size:13px;font-weight:600;letter-spacing:.11em;text-transform:uppercase;color:var(--accent-deep)}
.section-band .aside{margin-left:auto;font-size:13px;color:var(--ink-faint)}
.well{margin:0;background:var(--well);box-shadow:var(--well-edge);border:1px solid color-mix(in srgb,var(--shade) 7%,transparent);flex:1}
.pad{padding:18px 16px;display:flex;flex-direction:column;gap:14px}
.warning{border-color:var(--due)}
.warning .section-band h2{color:var(--due-ink)}
.warning .well{background:var(--due-soft);color:var(--due-ink)}
.warning th{background:var(--due-soft);color:var(--due-ink)}
.warning td{color:var(--due-ink)}

/* Where it went */
.bar{display:flex;gap:2px;height:22px;border-radius:var(--radius-sm);overflow:hidden}
.bar div{min-width:2px}
.shares{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:6px 24px}
.shares li{display:flex;align-items:center;gap:8px;font-size:14px}
.shares i,.key i,th i,.swatch{display:inline-block;width:10px;height:10px;border-radius:3px;flex-shrink:0}
.shares .name{color:var(--ink-strong)}.shares .amount{margin-left:auto;font-variant-numeric:tabular-nums;font-weight:500;color:var(--ink-strong)}
.note{font-size:13px;color:var(--ink-faint);border-top:1px solid color-mix(in srgb,var(--shade) 10%,transparent);padding-top:12px}
.note strong{color:var(--ink)}


/* Charts */
.chart{padding:16px 12px 8px;overflow-x:auto}
.chart svg{display:block;width:100%;min-width:640px;height:auto}
.trend+.trend{border-top:1px solid color-mix(in srgb,var(--shade) 10%,transparent);padding-top:16px}
.trend h3{font-size:14px;font-weight:600;color:var(--ink-strong)}
.chart-note{border:0;padding:0 4px 8px}
.trend .legend{padding:8px 4px 0}
.gridline{stroke:color-mix(in srgb,var(--shade) 10%,transparent)}
.axis{font-size:12px;fill:var(--ink-faint);font-family:inherit}
.total-area{fill:color-mix(in srgb,var(--accent) 8%,transparent)}
.legend{display:flex;flex-wrap:wrap;gap:4px 16px}
.key{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:400;color:var(--ink-soft);letter-spacing:0;text-transform:none}
.key i.dash{width:16px;height:0;border-top:2px dashed var(--ink-strong);border-radius:0;background:none}
.lines>g{transition:opacity .12s}
${HIGHLIGHT}

/* Tables */
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;font-size:14px}
.costs{min-width:760px}
th{position:sticky;top:0;padding:10px 12px;text-align:left;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-faint);background:var(--well);border-bottom:1px solid color-mix(in srgb,var(--shade) 14%,transparent);white-space:nowrap}
th a{color:inherit}
th i{margin-right:6px;vertical-align:-1px}
td{padding:11px 12px;border-bottom:1px solid color-mix(in srgb,var(--shade) 8%,transparent);vertical-align:top;color:var(--ink)}
th:first-child,td:first-child{padding-left:16px}th:last-child,td:last-child{padding-right:16px}
tbody tr:hover{background:color-mix(in srgb,var(--shade) 5%,transparent)}
tbody tr:last-child td{border-bottom:0}
.first{min-width:240px;max-width:420px;color:var(--ink-strong);font-weight:500}
.first a{color:var(--ink-strong);text-decoration:none}.first a:hover{color:var(--accent-deep);text-decoration:underline}
.first .muted{margin-top:2px;font-weight:400}.first .muted a{color:var(--accent-deep)}
.num{text-align:right;white-space:nowrap}.total{font-weight:600;color:var(--ink-strong)}
.split-head{width:200px}.split{display:flex;gap:1px;height:8px;margin-top:7px;border-radius:2px;overflow:hidden;background:color-mix(in srgb,var(--shade) 7%,transparent)}.split.bare{background:none}
.unpriced{color:var(--due-ink);font-size:.85em;font-weight:400;white-space:nowrap}
.foot{display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;padding:12px 16px;color:var(--ink-faint);font-size:13px;border-top:1px solid color-mix(in srgb,var(--shade) 8%,transparent)}
.jobs{list-style:none;margin:0;padding:0 4px;font-size:13px}
.jobs .failed{color:var(--due-ink)}
.empty{padding:28px 16px;color:var(--ink-faint)}

/* Cockpit's Claude calls: the tiles, the changes beside where the dollars went, and a share beside each amount */
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}
.tile{display:flex;flex-direction:column;gap:2px;padding:14px 16px;background:var(--well);box-shadow:var(--well-edge);border:1px solid color-mix(in srgb,var(--shade) 7%,transparent);outline:1px dotted color-mix(in srgb,var(--shade) 28%,transparent);outline-offset:4px;margin:5px;border-radius:0}
.tile-label{font-size:12px;font-weight:600;letter-spacing:.11em;text-transform:uppercase;color:var(--accent-deep)}
.tile-value{font-size:30px;font-weight:600;letter-spacing:-.02em;color:var(--ink-strong);font-variant-numeric:tabular-nums}
.tile.up .tile-value{color:var(--over-ink)}.tile.down .tile-value{color:var(--good)}
.tile-note{font-size:13px;color:var(--ink-faint)}
.row{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:20px}.row.alone{grid-template-columns:minmax(0,1fr)}
@media (max-width:900px){.row{grid-template-columns:minmax(0,1fr)}}
.shares .share{width:36px;text-align:right;color:var(--ink-faint);font-size:13px;font-variant-numeric:tabular-nums}
.changes{list-style:none;margin:0;padding:6px 0}
.changes li{display:grid;grid-template-columns:1fr auto;gap:0 12px;padding:9px 16px;border-bottom:1px solid color-mix(in srgb,var(--shade) 10%,transparent)}
.changes li:last-child{border-bottom:0}
.changes .name{color:var(--ink-strong);font-weight:500}.changes .delta{font-weight:600;font-variant-numeric:tabular-nums;text-align:right}.changes .from{grid-column:1/-1;font-size:13px;color:var(--ink-faint);font-variant-numeric:tabular-nums}
.pr-no{color:var(--accent-deep);font-weight:600}
.calls{min-width:860px}

/* A pull request */
.back{display:inline-flex;align-items:center;min-height:44px;align-self:flex-start}
.head{display:flex;flex-wrap:wrap;align-items:flex-start;gap:16px 40px}.head .title{flex:999 1 560px;min-width:0;display:flex;flex-direction:column;gap:6px}
h1{font-size:24px;font-weight:600;line-height:1.3;color:var(--ink-strong)}
.big{font-size:32px;font-weight:600;letter-spacing:-.02em;color:var(--ink-strong);text-align:right}.head .total-box{flex:1 1 200px;text-align:right}
.big .unpriced{font-size:14px}
.cat{display:grid;grid-template-columns:200px minmax(0,1fr) 150px 300px;gap:16px;align-items:center}.cat-name{display:flex;align-items:center;gap:8px;color:var(--ink-strong)}
.track{height:12px;background:color-mix(in srgb,var(--shade) 7%,transparent);border-radius:2px;overflow:hidden}
.sessions{min-width:900px}.sessions tr.session td{font-weight:500;background:color-mix(in srgb,var(--shade) 6%,transparent)}.sessions tr.agent td.agent-name{padding-left:28px}.sessions tr.agent td.indent{padding-left:48px}
@media (max-width:900px){.cat{grid-template-columns:1fr 1fr}.track{grid-column:1/-1}}

footer{padding:0 20px 28px;text-align:center;font-size:12px;color:var(--ink-faint)}footer a{color:inherit}

@media (max-width:640px){
  .topbar{padding:10px 12px 0}.status{display:none}.band{padding:8px 12px 0}
  .brand{order:-2}.appearance{order:-1;margin-left:auto}
  .pages{width:100%;overflow-x:auto;scrollbar-width:none}.pages a{white-space:nowrap;font-size:14px;padding:8px 12px 9px}
  main{padding:16px 16px 32px}
  .filters{display:grid;grid-template-columns:1fr 1fr;gap:10px}.filters select{width:100%}
  .button{grid-column:1/-1;margin-left:0;justify-content:center}
  .band-controls{padding:8px 12px 10px}.sentence-form{gap:6px}.sentence{font-size:15px;gap:6px 8px}.sentence select{height:34px;font-size:15px}
  .only{display:grid;grid-template-columns:1fr 1fr;gap:6px 8px}.only>span{grid-column:1/-1;margin:0}.only select,.only .button{height:32px}.only select{width:100%;min-width:0}
  .big{font-size:26px}
  .tiles{grid-template-columns:1fr 1fr;gap:8px}.tile:nth-child(3){grid-column:1/-1}.tile-value{font-size:26px}
}
`;
