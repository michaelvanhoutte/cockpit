import { esc, shell, band, type PageName } from './look';

/**
 * The frame the harness report pages share: a page's own tabs on the band, a
 * section over a well, tiles, the outcome bar, and the readings of a duration
 * and a rate. A report page is a tabs list, a filters form and panels, drawn
 * with `reportPage`; the series palette itself is in look.ts, which every
 * page takes.
 */

/** 9m 24s, 6h 23m: the report's own reading of a duration. */
export function humanMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** Floored, and 100% only for a rate that really is 1, so a rate never flatters. */
export function pct(rate: number): string {
  const p = rate === 1 ? 100 : Math.floor(rate * 1000) / 10;
  return `${p % 1 === 0 ? p.toFixed(0) : p.toFixed(1)}%`;
}

/** A link to GitHub: anything else is not linked, so a stored address can never send a reader elsewhere. */
export const githubUrl = (u: string | null | undefined) => (u && /^https:\/\/github\.com\//.test(u) ? esc(u) : '#');
export const outLink = (u: string | null | undefined, text: string, cls = '') =>
  `<a href="${githubUrl(u)}"${cls ? ` class="${cls}"` : ''} target="_blank" rel="noopener noreferrer">${text}</a>`;

/** A section over a well, named for a screen reader by its heading. */
export const section = (id: string, title: string, aside: string, content: string, cls = 'panel') =>
  `<section class="${cls}" aria-labelledby="${id}">${band(title, aside, id)}${content}</section>`;

/** A tile: a label, a figure and a note, or several, each its own line. */
export const tile = (label: string, value: string, note: string | string[], cls = '') =>
  `<div class="tile ${cls}"><span class="tile-label">${label}</span><span class="tile-value">${value}</span>${(typeof note === 'string' ? [note] : note).map((n) => `<span class="tile-note">${n}</span>`).join('')}</div>`;

/** A page's own tabs on the band: `[href, text, current]`. */
export const bandTabs = (tabs: [href: string, text: string, current: boolean][]) =>
  tabs.map(([href, text, on]) => `<a href="${href}"${on ? ' aria-current="page"' : ''}>${text}</a>`).join('');

/** What a report page adds to the shared stylesheet. */
export const REPORT_STYLE = `
.faint{color:var(--ink-faint)}.faint-num{color:var(--ink-faint)}
.sub{margin-top:2px;font-size:13px;font-weight:400;color:var(--ink-faint)}.sub a{color:var(--accent-deep)}
.notice{margin:0;padding:10px 14px;border-radius:var(--radius-md);background:var(--due-soft);color:var(--due-ink);font-size:14px}.notice a{color:inherit}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}
.tile{display:flex;flex-direction:column;gap:2px;padding:14px 16px;background:var(--well);box-shadow:var(--well-edge);border:1px solid color-mix(in srgb,var(--shade) 7%,transparent);outline:1px dotted color-mix(in srgb,var(--shade) 28%,transparent);outline-offset:4px;margin:5px}
.tile-label{font-size:12px;font-weight:600;letter-spacing:.11em;text-transform:uppercase;color:var(--accent-deep)}
.tile-value{font-size:30px;font-weight:600;letter-spacing:-.02em;color:var(--ink-strong);font-variant-numeric:tabular-nums}
.tile.up .tile-value{color:var(--over-ink)}.tile.down .tile-value{color:var(--good)}
.tile-note{font-size:13px;color:var(--ink-faint)}
.row{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:20px}
@media (max-width:900px){.row{grid-template-columns:1fr}}
.where{display:flex;flex-direction:column;gap:16px;padding:18px 16px}
.changes{list-style:none;margin:0;padding:6px 0;flex:1}
.changes li{display:grid;grid-template-columns:1fr auto;gap:0 12px;padding:9px 16px;border-bottom:1px solid color-mix(in srgb,var(--shade) 10%,transparent)}
.changes li:last-child{border-bottom:0}
.changes .name{color:var(--ink-strong);font-weight:500}.changes .delta{font-weight:600;font-variant-numeric:tabular-nums;text-align:right}.changes .from{grid-column:1/-1;font-size:13px;color:var(--ink-faint);font-variant-numeric:tabular-nums}
.table{overflow-x:auto}.table table{min-width:860px}
.split-cell{width:200px}
@media (max-width:640px){
  .tiles{grid-template-columns:1fr 1fr;gap:8px}.tile:last-child:nth-child(odd){grid-column:1/-1}
  .tile-value{font-size:26px}
}
`;

/** A report page: the top bar with `current` selected, the page's own tabs on the band, and its panels. */
export function reportPage(page: { current: PageName; tabs: string; body: string; style?: string }, now: number): string {
  return shell({ ...page, style: REPORT_STYLE + (page.style ?? '') }, now);
}
