/**
 * What a chart, tile or table explains about itself, behind an (i) beside its
 * heading or label. The text is fixed and drawn into the page with it, so
 * opening one sends no request: pointing at the (i) opens it, a click or tap
 * keeps it open, and leaving, a second click, a click elsewhere or Escape
 * closes it.
 */

/** What a panel says of itself; a grouping tab's table has only `shows`. */
export interface Explanation {
  shows: string;
  read?: string;
  look?: string;
}

/** An (i) and the explanation it opens, drawn apart so a caller can place the button on a label's line. */
export interface Info {
  button: string;
  panel: string;
  /** Both, for a heading, which keeps them side by side. */
  both: string;
}

const body = (e: Explanation) =>
  `<dl class="explain-text"><dt>What it shows</dt><dd>${e.shows}</dd>${e.read ? `<dt>How to read it</dt><dd>${e.read}</dd>` : ''}${e.look ? `<dt>What to look for</dt><dd>${e.look}</dd>` : ''}</dl>`;

/** The (i) for `name`, a plain heading or label, and the explanation it opens. `id` is unique on the page. */
export function explain(id: string, name: string, e: Explanation): Info {
  const button = `<button type="button" class="info" data-pop="x-${id}" aria-controls="x-${id}" aria-expanded="false" aria-label="How to read ${name}">i</button>`;
  const panel = `<div id="x-${id}" popover="manual" class="explain-pop">${body(e)}</div>`;
  return { button, panel, both: button + panel };
}

/** A tile's label with its (i) bound to the label's last word, so the (i) wraps with that word and never onto a line of its own. */
export function labelWithInfo(label: string, button: string): string {
  const at = label.lastIndexOf(' ') + 1;
  return `${label.slice(0, at)}<span class="nw">${label.slice(at)}${button}</span>`;
}

/** A page's lead: the question it answers, and a sentence defining the words a newcomer will not know. */
export const lead = (question: string, more: string) => `<div class="lead"><p class="lead-q">${question}</p><p class="lead-more">${more}</p></div>`;

export const EXPLAIN_STYLE = `
.lead{padding:4px 2px 0}
.lead-q{margin:0;font-size:18px;font-weight:600;color:var(--ink-strong);text-wrap:balance}
.lead-more{max-width:820px;margin:4px 0 0;font-size:14px;color:var(--ink-soft);line-height:1.5;text-wrap:pretty}
.heading{display:flex;align-items:center}
.nw{white-space:nowrap}
.info{position:relative;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;width:18px;height:18px;margin-left:8px;padding:0;border:1px solid currentColor;border-radius:50%;background:none;color:var(--ink-faint);font:italic 600 11px/1 Georgia,serif;letter-spacing:0;text-transform:none;vertical-align:2px;cursor:pointer}
.info:hover,.info:focus-visible,.info[aria-expanded="true"]{color:var(--accent-deep);border-color:var(--accent-deep)}
@media (pointer:coarse){.info::after{content:'';position:absolute;inset:-10px}}
.tile-label .info{margin-left:6px;width:16px;height:16px;font-size:10px;vertical-align:1px}
.explain-pop{position:absolute;inset:auto;margin:0;width:min(440px,calc(100% - 32px));max-height:min(70vh,560px);overflow:auto;padding:14px 16px;border:1px solid color-mix(in srgb,var(--shade) 14%,transparent);border-radius:var(--radius-md);background:var(--well);color:var(--ink);box-shadow:0 10px 30px rgba(0,0,0,.28);text-transform:none;letter-spacing:0;font-weight:400}
.explain-text{margin:0;font-size:14px;line-height:1.5}
.explain-text dt{margin-top:10px;font-size:11px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--accent-deep)}
.explain-text dt:first-child{margin-top:0}
.explain-text dd{margin:2px 0 0}
`;

/**
 * Opens an (i)'s explanation on pointing, keeps it on a click or tap, and closes
 * it on leaving (unless kept), a second click, a click elsewhere or Escape. One
 * is open at a time. It is placed under its (i), kept inside the screen's width.
 * `window.explainBind(root)` binds the (i)s a page adds later, as the Test
 * coverage panel does when it swaps one in.
 */
export const EXPLAIN_SCRIPT = `<script>
(function(){
  if(!HTMLElement.prototype.showPopover)return;
  var open=null,kept=false,timer;
  function place(){
    var r=open.b.getBoundingClientRect(),p=open.p,w=document.documentElement.clientWidth;
    var left=Math.max(16,Math.min(r.left-12,w-p.offsetWidth-16));
    var top=r.bottom+8;
    if(top+p.offsetHeight>innerHeight&&r.top-8-p.offsetHeight>0)top=r.top-8-p.offsetHeight;
    p.style.left=(left+scrollX)+'px';p.style.top=(top+scrollY)+'px';
  }
  function hide(){
    clearTimeout(timer);
    if(!open)return;
    if(open.p.isConnected)open.p.hidePopover();
    open.b.setAttribute('aria-expanded','false');open=null;kept=false;
  }
  function show(b){
    clearTimeout(timer);
    if(open&&open.b===b)return;
    hide();
    var p=document.getElementById(b.dataset.pop);
    p.showPopover();b.setAttribute('aria-expanded','true');
    open={b:b,p:p};kept=false;place();
  }
  function leave(){clearTimeout(timer);timer=setTimeout(function(){if(!kept)hide()},150)}
  function bind(root){
    root.querySelectorAll('.info').forEach(function(b){
      if(b.dataset.bound)return;
      b.dataset.bound='1';
      var p=document.getElementById(b.dataset.pop);
      b.addEventListener('mouseenter',function(){show(b)});
      b.addEventListener('mouseleave',leave);
      p.addEventListener('mouseenter',function(){clearTimeout(timer)});
      p.addEventListener('mouseleave',leave);
      b.addEventListener('click',function(){
        if(open&&open.b===b&&kept){hide();return}
        show(b);kept=true;
      });
    });
  }
  bind(document);
  window.explainBind=bind;
  document.addEventListener('click',function(e){
    if(open&&!open.b.contains(e.target)&&!open.p.contains(e.target))hide();
  });
  document.addEventListener('keydown',function(e){if(e.key==='Escape')hide()});
  addEventListener('resize',function(){if(open)place()});
})();
</script>`;
