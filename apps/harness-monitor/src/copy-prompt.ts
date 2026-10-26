import { esc } from './look';

/**
 * A row's Copy prompt: a button with the prompt it copies, which is in the page
 * and never shown, so a click sends no request. Test selection's rules and
 * misses and CI stability's workflows draw it the same way.
 */

/** A Copy prompt button with the prompt it copies, which is in the page and never shown. */
export const promptBox = (text: string) => `<div class="prompt-cell"><button type="button" class="copy-prompt">Copy prompt</button><pre hidden>${esc(text)}</pre></div>`;

/** Copies the prompt a button sits beside, which is in the page and never shown, and says so for a moment. */
export const COPY_SCRIPT = `<script>document.addEventListener('click',function(e){var b=e.target.closest('.copy-prompt');if(!b)return;var pre=b.parentNode.querySelector('pre');var say=function(t){b.textContent=t;setTimeout(function(){b.textContent='Copy prompt'},1500)};var fail=function(){say('Could not copy')};try{navigator.clipboard.writeText(pre.textContent).then(function(){say('Copied')},fail)}catch(x){fail()}});</script>`;

export const COPY_STYLE = `
.copy-prompt{font:inherit;font-size:13px;padding:4px 10px;border-radius:6px;border:1px solid var(--line,#444);background:transparent;color:var(--accent-deep);cursor:pointer}
`;
