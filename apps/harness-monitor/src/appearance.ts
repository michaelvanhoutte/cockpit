/**
 * Whether a page is drawn light or dark, decided in the browser before first
 * paint. Every viewer is sent the same page (the edge caches it and shares it),
 * so the Worker renders neither the choice nor the option the select shows:
 * this script, inlined in the head by `shell` (src/look.ts), applies both.
 *
 * The choice (`monitor.appearance` in this browser's storage: `light` or
 * `dark`, absent for Match device, anything else treated as absent) becomes
 * `data-appearance` on the document. Without it the stylesheet follows the
 * device's own scheme, so a device switching needs no script; with it, the
 * stylesheet draws that choice whatever the device says. It mirrors Cockpit's
 * Appearance (apps/web/src/appearanceBoot.js) and shares no code with it.
 *
 * Plain ES5 taking the window as its argument, so a test can hand it a fake one
 * (tests/unit/appearance.test.ts). Storage may refuse a read, which follows the
 * device, or a write, which still applies the choice and does not remember it.
 */
export const APPEARANCE_BOOT = `(function(win){
var KEY='monitor.appearance';
var root=win.document.documentElement;
function remembered(){try{var v=win.localStorage.getItem(KEY);return v==='light'||v==='dark'?v:null}catch(e){return null}}
function draw(choice){if(choice)root.setAttribute('data-appearance',choice);else root.removeAttribute('data-appearance')}
function show(){var select=win.document.getElementById('appearance');if(select)select.value=root.getAttribute('data-appearance')||''}
draw(remembered());
win.monitorAppearance={
show:show,
choose:function(value){var choice=value==='light'||value==='dark'?value:null;try{if(choice)win.localStorage.setItem(KEY,choice);else win.localStorage.removeItem(KEY)}catch(e){}draw(choice);show()}
};
win.addEventListener('storage',function(event){if(event.key===KEY||event.key===null){draw(remembered());show()}});
})(window)`;
