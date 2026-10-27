import { ORANGE } from './palette';

/**
 * What CI stability's Workflow and Fragile tests tabs draw the same way: a row
 * that opens to a strip with main beside the feature branches, the script that
 * opens it, the tags beside a name and the style of all of it.
 */

export const dash = '<span class="faint">—</span>';
export const whereTag = (onMain: boolean) => (onMain ? '<span class="tag main">main</span>' : '<span class="tag">branch</span>');
/** A cause's name without the describe blocks above it. */
export const shortName = (label: string) => label.split(' > ').pop()!.split(' › ').pop()!;

/** The strip a row opens to: two sides, main's and the feature branches', and a line beneath them. It is in the page, hidden, so opening it sends nothing. */
export const strip = (main: string, branches: string, foot: string) => `<div class="strip"><div class="sides">${main}${branches}</div><p class="side-foot">${foot}</p></div>`;

/**
 * A row opens, from its chevron or a click outside its links and its Copy
 * prompt, as Cycle time's rows do (src/cycle-time-strip.ts): the chevron is the
 * script's own, so without it the table is as it was, a click with text selected
 * in the row selects rather than toggles, and the strip, already in the page,
 * is shown or hidden: opening sends nothing. A row's `data-opens` names it for
 * the chevron's label where it has a value, otherwise its first cell does.
 */
export const OPEN_SCRIPT = `<script>(function(){
  var table=document.querySelector('table.openable');
  if(!table)return;
  var body=table.tBodies[0];
  function toggle(row){
    var open=row.classList.toggle('open');
    var button=row.querySelector('.chev');
    button.setAttribute('aria-expanded',String(open));
    button.setAttribute('aria-label',button.getAttribute('aria-label').replace(/^(Open|Close)/,open?'Close':'Open'));
    row.nextElementSibling.hidden=!open;
  }
  body.addEventListener('click',function(e){
    var row=e.target.closest('tr[data-opens]');
    if(!row||!body.contains(row))return;
    var inside=e.target.closest('a,.copy-prompt');
    if(inside&&row.contains(inside))return;
    var selected=window.getSelection();
    if(selected&&String(selected)!==''&&row.contains(selected.anchorNode)&&!e.target.closest('button'))return;
    toggle(row);
  });
  [].forEach.call(body.querySelectorAll('tr[data-opens]'),function(row){
    var button=document.createElement('button');
    button.type='button';
    button.className='chev';
    button.textContent='\\u203A';
    button.setAttribute('aria-expanded','false');
    button.setAttribute('aria-label','Open '+(row.getAttribute('data-opens')||row.cells[0].textContent).replace(/\\s+/g,' ').trim());
    row.cells[0].insertBefore(button,row.cells[0].firstChild);
  });
})();</script>`;

export const ROWS_STYLE = `
.lasted .fill.branch{background:${ORANGE};opacity:.55}
.tag{display:inline-block;font-size:11px;font-weight:600;padding:1px 6px;border-radius:4px;background:color-mix(in srgb,var(--shade) 8%,transparent);color:var(--ink-soft);vertical-align:1px}
.tag.main{background:color-mix(in srgb,var(--over) 22%,transparent);color:var(--over-ink)}
td.fix{white-space:nowrap;text-align:right}
.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
section[aria-labelledby=by-workflow] :is(th,td),section[aria-labelledby=fragile] :is(th,td){padding-left:10px;padding-right:10px}
section[aria-labelledby=by-workflow] td.first,section[aria-labelledby=fragile] td.first{min-width:0}
.chev{border:0;background:none;color:var(--ink-faint);font-size:16px;line-height:1;width:18px;padding:0;margin-right:6px;cursor:pointer;transition:transform .15s}
table.openable tr[data-opens]{cursor:pointer}table.openable tr.open .chev{transform:rotate(90deg)}table.openable tr.open[data-opens] td{background:var(--accent-tint)}
tr.detail td{padding:4px 16px 16px;background:color-mix(in srgb,var(--accent-tint) 50%,transparent)}
/* The table can be wider than its panel and scroll inside it; a strip stays as wide as the panel and keeps to the visible edge, as Cycle time's does, so its causes are never out of sight. */
.well.table:has(>.openable){container-type:inline-size}
.strip{position:sticky;left:0;width:calc(100cqw - 34px)}
.sides{display:grid;grid-template-columns:1fr 1fr;gap:20px}
@media (max-width:720px){.sides{grid-template-columns:1fr}}
.side h4{margin:8px 0 2px;font-size:12px;letter-spacing:.06em;text-transform:uppercase}.side.main h4{color:var(--over-ink)}.side.branch h4{color:var(--ink-soft)}
.side .small{margin:0 0 8px}
.causes{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.causes li{display:flex;gap:10px;align-items:baseline;font-size:13px}
.causes .n{flex:none;min-width:30px;font-size:12px;font-weight:600;text-align:right}.causes .n.main{color:var(--over-ink)}.causes .n.branch{color:var(--ink-soft)}
.side-foot{margin:12px 0 0;font-size:12px;color:var(--ink-faint)}
.err{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;color:var(--over-ink)}
`;
