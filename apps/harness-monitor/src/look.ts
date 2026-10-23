import { belgianDay, formatDateTime } from './belgium';

/**
 * Cockpit's look on the Monitor's pages: the stylesheet, the top bar, the band,
 * the section heading and the page around them. The Monitor imports nothing
 * from Cockpit, so the values below are copied by value from
 * docs/design-system.md and apps/web/src/styles.css, not shared.
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

/** The pages the top bar lists, in order. */
export type PageName = 'costs';

/** A section heading: the strip Cockpit draws over a panel, with an optional note at its right. */
export const band = (title: string, aside = '', id = '') =>
  `<div class="section-band"><h2${id === '' ? '' : ` id="${id}"`}>${title}</h2>${aside === '' ? '' : `<span class="aside">${aside}</span>`}</div>`;

/** A control that holds a value wears `data-set`, as Cockpit's filters do. */
export function selectField(id: string, label: string, options: [value: string, text: string][], current: string, resting = ''): string {
  const opts = options
    .map(([value, text]) => `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(text)}</option>`)
    .join('');
  return `<div class="field"><label for="${id}">${label}</label><select id="${id}" name="${id}" onchange="this.form.submit()"${current === resting ? '' : ' data-set'}>${opts}</select></div>`;
}

/** The top bar: the mark, the name, one tab per page and when the figures were read. */
function chrome(current: PageName, now: number): string {
  return `<header class="topbar">
<a class="brand" href="/">${LOGO}<span>Harness Monitor</span></a>
<nav class="pages" aria-label="Pages"><a href="/"${current === 'costs' ? ' aria-current="page"' : ''}>Claude Code costs</a></nav>
<span class="status">Updated ${formatDateTime(now)} · public, read-only</span>
</header>`;
}

/** What a page is drawn with: which tab is current, the groupings on the band (none for a page without), and the page itself. */
export function shell(page: { current: PageName; tabs?: string; body: string }, now: number): string {
  // A page with no groupings keeps the band as a bare strip, so its tab still runs into it.
  const strip = page.tabs === undefined ? '<div class="band"></div>' : `<nav class="band" aria-label="Group by"><div class="band-tabs">${page.tabs}</div></nav>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Harness Monitor</title>
<link rel="preload" href="${FONT_URL}" as="font" type="font/woff2" crossorigin>
<style>${STYLE}</style>
</head><body>
${chrome(page.current, now)}
${strip}
<main>
${page.body}
</main>
<footer>© ${belgianDay(now).slice(0, 4)} Conselit · <a href="https://www.conselit.be" target="_blank" rel="noopener noreferrer">conselit.be</a></footer>
</body></html>`;
}

/** Cockpit's tokens (docs/design-system.md), copied by value: the Monitor shares no code with Cockpit. */
export const STYLE = `
@font-face{font-family:'Inter Variable';font-style:normal;font-display:swap;font-weight:100 900;src:url(${FONT_URL}) format('woff2-variations')}
:root{
  --ground:#e2e2df;--surface:#f4f5fb;--field:#fff;--well:color-mix(in srgb,var(--ground) 40%,#fff);
  --ink-strong:#16181d;--ink:#3a3f4b;--ink-soft:#555b68;--ink-faint:#5a5f6d;--shade:#16181d;
  --graphite-top:#2d2e35;--graphite-bottom:#16181d;--chrome-ink:#f2f1f8;--chrome-ink-soft:#a5a3b5;
  --accent:#6f62b5;--accent-deep:#5d5294;--accent-soft:#b5abfc;--accent-tint:#e7e5fe;--on-accent:#fff;--bar:#594e91;--logo-dot:#9a8fd6;
  --cat-slate:#2f4f7a;--cat-teal:#0e7490;--cat-amber:#c98a4b;--cat-green:#0b7a55;--cat-violet:#6a4cc9;--cat-grey:#a7b0be;
  --due:#c98a4b;--due-soft:#f1dcc0;--due-ink:#6b4515;--over:#bf5d55;--over-ink:#9d4d46;--good:#0b7a55;
  --shadow-panel:0 0 0 1px color-mix(in srgb,var(--accent) 14%,#d3d6e2),0 1px 2px rgb(22 24 29 / .05);
  --well-edge:inset 0 2px 3px -1px rgb(22 24 29 / .12);
  --radius-sm:4px;--radius-md:10px;--radius-lg:14px;
  color-scheme:light;
}
@media (prefers-color-scheme:dark){:root{
  --ground:#23242a;--surface:#24252b;--field:#141519;--well:#141418;
  --ink-strong:#e4e5ea;--ink:#c2c5cd;--ink-soft:#9a9eaa;--ink-faint:#8a8e9a;--shade:#e4e5ea;
  --accent-deep:#b3abdb;--accent-tint:color-mix(in srgb,#6f62b5 22%,#23242a);
  --cat-slate:#93a6c2;--cat-teal:#5fc0d3;--cat-amber:#e3a752;--cat-green:#4ad6a0;--cat-violet:#b09af8;--cat-grey:#a7b0be;
  --due-soft:#4a3519;--due-ink:#e8c08a;--over-ink:#e0867f;--good:#4ad6a0;
  --shadow-panel:0 0 0 1px rgb(255 255 255 / .06),0 1px 2px rgb(0 0 0 / .3);
  --well-edge:inset 0 2px 3px -1px rgb(0 0 0 / .5),0 0 0 1px rgb(255 255 255 / .04);
  color-scheme:dark;
}}
*{box-sizing:border-box}
html{background:var(--ground)}
body{margin:0;background:var(--ground);color:var(--ink);font:15px/1.55 'Inter Variable',Inter,system-ui,sans-serif;font-feature-settings:'cv11','ss01';-webkit-font-smoothing:antialiased}
a{color:var(--accent-deep);text-decoration-color:color-mix(in srgb,currentColor 35%,transparent);text-underline-offset:2px}
a:hover{text-decoration-color:currentColor}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:var(--radius-sm)}
h1,h2,h3,p{margin:0}
.muted{color:var(--ink-faint)}.small{font-size:13px}.nowrap{white-space:nowrap}.mono{font-variant-numeric:tabular-nums}.scroll{overflow-x:auto}

/* Top bar and band */
.topbar{display:flex;align-items:center;gap:8px 20px;flex-wrap:wrap;padding:10px 20px 0;background:linear-gradient(var(--graphite-top),var(--graphite-bottom));color:var(--chrome-ink);border-top:3px solid var(--accent)}
.pages a::before{content:'';display:inline-block;width:8px;height:8px;margin-right:8px;border-radius:50%;background:var(--dot,var(--chrome-ink-soft));vertical-align:1px}
.pages a:first-child{--dot:#e3a752}
.brand{display:flex;align-items:center;gap:10px;color:var(--chrome-ink);text-decoration:none;font-weight:600;font-size:15px;padding-bottom:10px}
.logo{width:24px;height:24px;flex-shrink:0}
.pages{display:flex;gap:2px;align-self:flex-end}
.pages a{padding:9px 18px 10px;border-radius:var(--radius-md) var(--radius-md) 0 0;color:var(--chrome-ink-soft);text-decoration:none;font-size:16px;font-weight:500}
.pages a:hover{color:var(--chrome-ink);background:rgb(255 255 255 / .06)}
.pages a[aria-current=page]{background:var(--bar);color:var(--chrome-ink)}
.status{margin-left:auto;color:var(--chrome-ink-soft);font-size:12px;padding-bottom:10px}
.band{background:var(--bar);padding:8px 20px 0}
.band-tabs{display:flex;gap:4px;overflow-x:auto;scrollbar-width:none}
.band-tabs a{flex-shrink:0;padding:7px 14px 9px;border-radius:var(--radius-md) var(--radius-md) 0 0;color:var(--chrome-ink);text-decoration:none;font-size:16px;font-weight:500;opacity:.9}
.band-tabs a:hover{opacity:1;background:rgb(255 255 255 / .08)}
.band-tabs a[aria-current=page]{background:var(--ground);color:var(--ink-strong);opacity:1;font-weight:600}

main{max-width:1320px;margin:0 auto;padding:20px 20px 40px;display:flex;flex-direction:column;gap:20px}

/* Filters */
.filters{display:flex;flex-wrap:wrap;align-items:flex-end;gap:12px 16px}
.field{display:flex;flex-direction:column;gap:4px}
.field>span,.field>label{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-faint)}
select{height:38px;padding:0 32px 0 12px;font:inherit;font-size:14px;color:var(--ink-strong);background:var(--field) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%235a5f6d' stroke-width='1.5'/%3E%3C/svg%3E") no-repeat right 12px center;border:1px solid color-mix(in srgb,var(--shade) 18%,transparent);border-radius:var(--radius-md);appearance:none;box-shadow:inset 0 1px 2px rgb(22 24 29 / .06);cursor:pointer}
select[data-set]{border:2px solid var(--accent);padding-left:11px}
.toggles{display:flex;gap:2px;padding:3px;border-radius:var(--radius-md);background:color-mix(in srgb,var(--shade) 7%,transparent)}
.toggles button{height:32px;padding:0 14px;border:0;border-radius:7px;background:none;font:inherit;font-size:14px;font-weight:500;color:var(--ink-soft);cursor:pointer}
.toggles button:hover{color:var(--ink-strong);background:color-mix(in srgb,var(--shade) 6%,transparent)}
.toggles button[aria-pressed=true]{background:var(--accent);color:var(--on-accent);box-shadow:inset 0 1px 0 rgb(255 255 255 / .15),0 1px 2px rgb(22 24 29 / .2)}
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

/* The change on the previous period */
.change h3{margin:0 0 4px;font-size:13px;font-weight:600;color:var(--ink-strong)}
.change ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.dimensions{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}
.drivers{min-width:420px}
.up{color:var(--over-ink)}.down{color:var(--good)}

/* Charts */
.chart{padding:16px 12px 8px;overflow-x:auto}
.chart svg{display:block;width:100%;min-width:640px;height:auto}
.trend+.trend{border-top:1px solid color-mix(in srgb,var(--shade) 10%,transparent);padding-top:16px}
.trend h3{font-size:14px;font-weight:600;color:var(--ink-strong)}
.trend .note{border:0;padding:0 0 8px}
.trend .legend{padding:8px 4px 0}
.gridline{stroke:color-mix(in srgb,var(--shade) 10%,transparent)}
.axis{font-size:12px;fill:var(--ink-faint);font-family:inherit}
.total-area{fill:color-mix(in srgb,var(--accent) 8%,transparent)}
.legend{display:flex;flex-wrap:wrap;gap:4px 16px}
.key{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:400;color:var(--ink-soft);letter-spacing:0;text-transform:none}
.key i.dash{width:16px;height:0;border-top:2px dashed var(--ink-strong);border-radius:0;background:none}

/* Tables */
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;font-size:14px}
.costs{min-width:1100px}
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
  .pages{width:100%;overflow-x:auto;scrollbar-width:none}.pages a{white-space:nowrap;font-size:14px;padding:8px 12px 9px}.band-tabs a{font-size:14px;padding:7px 12px 9px}
  .toggles button{white-space:nowrap;font-size:13px}
  main{padding:16px 16px 32px}
  .filters{display:grid;grid-template-columns:1fr 1fr;gap:10px}.filters select{width:100%}
  .filters .field:has(.toggles),.button{grid-column:1/-1}.toggles button{flex:1;padding:0 6px}.button{margin-left:0;justify-content:center}
  .big{font-size:26px}
}
`;
