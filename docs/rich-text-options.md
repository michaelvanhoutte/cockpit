# Rich text for an Item description

**Status: decided — Milkdown.** The spike ran; see "What the spike found", which is the section to read first. It confirmed the recommendation and corrected two claims below that were taken from published documentation and are false as of 7.22.1: Milkdown's `html` node escapes rather than injects, and both ProseMirror candidates now sanitise a link's rendered `href`.

## What has to be true

1. **WYSIWYG.** Bold looks bold while you type.
2. **A source view, switchable both ways.** Hard requirement, and it forces the stored format to be human-readable Markdown rather than editor JSON.
3. **First formatting set**: bold, italic, link, bullet list, numbered list. Everything else is escaped, not rendered.
4. **Tables and images are expected later**, plus probably headings, blockquote, code block, strikethrough, checklists. What they cost as a later addition is the column that decides this.
5. **The bundle gate** (`architecture.md`, "Performance budgets"): < 200KB compressed initial JS, hard CI gate, and heavy dependencies are lazy-loaded or rejected.
6. **Security** (`architecture.md`, "Security"): descriptions will later carry text a connector pulled from Gmail, Slack and Notion. Prefer making raw HTML and `javascript:`/`data:` URLs unrepresentable over sanitising them afterwards.
7. **Testability**: the web tier is Vitest + jsdom + Testing Library. An editor that only runs in a real browser pushes its tests to Playwright.
8. **Mobile**: installed PWA, capture happens on a phone.

## The candidates

| | Source view round-trip | Tables + images later | Compressed size | Raw HTML | jsdom |
|---|---|---|---|---|---|
| **Milkdown** (ProseMirror + remark) | re-serialised, normalised | preset swap (`preset-gfm`); images already in `preset-commonmark` | 104KB (`@milkdown/preset-commonmark` 7.22.1) | an `html` node exists in the preset, and escapes rather than injects | needs Range mocks; selection untestable |
| **Tiptap 3** (ProseMirror) | re-serialised, normalised | first-party extensions + a serializer rule each | 105KB (`starter-kit` 3.31.0) + 18KB (`@tiptap/markdown`) | unrepresentable: not in the schema | needs Range mocks; selection untestable |
| **Lexical** (Meta) | re-serialised; unmatched syntax survives as literal text | **both hand-written**: `@lexical/table` ships but its Markdown transformer does not, and there is no image node at all | 56KB core; `@lexical/markdown` 75KB, graphs overlap and cannot be summed | unrepresentable: node registry is an allowlist | **runs with no DOM** via `@lexical/headless` |
| **`<textarea>` + preview** | **lossless — the stored text is the text** | free in the editor; the cost moves entirely to the renderer | renderer only (see below) | renderer's problem | trivial |
| Hand-rolled `contenteditable` | — | — | — | — | — |

**Hand-rolled `contenteditable` is dismissed.** Every candidate above exists because browsers disagree about what `contenteditable` does to selection, composition and Android IME; writing that reconciler is the whole product for a year.

### What "normalised" means concretely

ProseMirror parses Markdown into a document tree and the source view re-prints that tree, so it hands back *equivalent* text, not *your* text. Observed classes of change: bullet markers unify (`-`, `+`, `*` → one), emphasis delimiters unify (`_em_` → `*em*`), setext headings become ATX, ordered lists are renumbered from their start, indentation and blank lines are regularised, and reference-style links are inlined.

**The damaging case is not cosmetic.** Anything absent from the schema is dropped at parse time and does not come back: with only the first formatting set configured, a table pasted out of Notion vanishes the moment the item is opened. That argues for configuring the schema wider than the toolbar from day one — parse and preserve what you do not yet offer a button for.

Lexical fails more softly. `@lexical/markdown` ships transformers for headings, quote, code, both list kinds, bold/italic/strikethrough/inline code and links — exactly the first formatting set plus a little. Unmatched syntax is left as literal text rather than deleted, which is a real advantage, but re-serialisation still normalises.

### Sizes, and what the numbers are worth

Figures are Bundlephobia's minified+gzip for the whole published dependency graph, taken 2026-09-03. **They cannot be added up**: `lexical`, `@lexical/rich-text` (73KB) and `@lexical/markdown` (75KB) each count the shared core, and `@tiptap/extension-table` reads as 4KB only because `prosemirror-tables` (66KB standalone) is a peer. `@milkdown/kit` reads as 152 bytes because it is a re-export shell — use `@milkdown/preset-commonmark` as the honest proxy. An independent benchmark of eight editors on React 19.2.8 (August 2026) puts Tiptap's core at 34KB gzip and its starter kit at 105KB, agreeing with Bundlephobia.

**No WYSIWYG option fits inline.** One hundred-odd kilobytes is half the entire budget before Cockpit's own code, so all three must be lazy-loaded behind the item detail dialog. That is a fine answer — the dialog is not on the cold-open path, and the standing rule already says heavy dependencies are lazy-loaded or rejected — but it has to be designed in, not discovered: the dialog becomes an async boundary with a loading state, and the CI gate has to charge the chunk to the right budget.

**The renderer is the size question that actually bites**, because the read-only view is on the cold-open path if descriptions appear in panel rows. Tables and images change the editor chunk, not that one.

### Security

Tiptap and Lexical both make the unsafe case unrepresentable rather than sanitising it: a node absent from the schema (or from Lexical's registered node list) cannot exist in the document, so pasted `<script>` has nowhere to go, and both render into DOM they construct — no `dangerouslySetInnerHTML` anywhere. Milkdown is the same machinery with one exception worth naming: its CommonMark preset registers an `html` node. The spike found that node renders its source as escaped text rather than as markup, which is what Cockpit wants — **keep it**, and see "Two corrections" for why removing it would be the worse trade.

**No candidate keeps a link's href out of the stored Markdown.** Milkdown and Tiptap both render an unsafe scheme as `href=""`, but `javascript:alert(1)` typed into the link dialog is stored as written by both. Whichever wins, the URL scheme allowlist is Cockpit's own, tested at F1 — it is not free anywhere.

### Testability and mobile

`EditorView` needs `Range.prototype.getClientRects`, `getBoundingClientRect` and `elementFromPoint`, none of which jsdom implements, so ProseMirror-based editors (Tiptap and Milkdown alike) mount only behind setup mocks — and once mocked, selection is fake, so every test about selection or the toolbar is a Playwright test. **Lexical is the outlier**: `@lexical/headless` runs the editor with no DOM at all, which makes Markdown import/export and command logic ordinary unit tests. `<textarea>` is trivially testable.

On mobile all three are comparable — ProseMirror's Android `MutationObserver` path is the longest battle-tested, Lexical was built at Meta for mobile web and takes the same approach — and all three are headless, so **the floating selection toolbar is hand-written work either way**. The `<textarea>` baseline inherits the platform's own selection, which is the best touch behaviour available, but a side-by-side preview is a desktop affordance: the phone keyboard covers it.

## The Markdown renderer for the read-only view

| | Compressed | Output | Raw HTML | URL schemes |
|---|---|---|---|---|
| **`react-markdown` 10.1.0** | 34KB | **React elements**, no `dangerouslySetInnerHTML` | escaped unless `rehype-raw` is added (+~60KB) | `defaultUrlTransform` allows http, https, irc, ircs, mailto, xmpp and relative only |
| `markdown-it` 15.0.1 | 47KB | HTML string → `dangerouslySetInnerHTML` | escaped by default (`html: false`) | `validateLink` blocks `javascript:`, `vbscript:`, `file:` and all `data:` but image types |
| `marked` 18.0.11 | 13KB | HTML string → `dangerouslySetInnerHTML` | **passed through**; no sanitiser since v5 | none — needs DOMPurify (+11KB) and a link check |
| `micromark` 4.0.2 | 15KB | HTML string → `dangerouslySetInnerHTML` | same | same; it is the parser under `react-markdown` anyway |

**`react-markdown`.** It is the only one whose safe behaviour is structural rather than configured — it never produces an HTML string, so there is no sanitising step to forget — and constraint 3 falls out of its `allowedElements` prop instead of needing a parser mode. `marked` plus DOMPurify is 10KB cheaper and one config mistake away from an XSS; that is the wrong trade for text a connector fetched.

## Recommendation

**Milkdown, lazy-loaded behind the item detail dialog, with `react-markdown` for the read-only view.**

1. **Markdown is Milkdown's document model, not an export format.** Constraint 2 is the hard one, and Milkdown is the only WYSIWYG candidate that was designed around it — remark parses and prints, ProseMirror only edits in between.
2. **The growth path is a preset line.** Tables arrive as `@milkdown/preset-gfm`, images are already in `preset-commonmark`, and both round-trip through remark with no serializer written by us. Tiptap costs a package and a serialization rule per feature; Lexical costs a hand-written transformer for tables and a hand-written node *and* transformer for images.
3. **It is the smallest of the three**, at 104KB against Tiptap's 105 + 18 — and by more than that once measured (see "What the spike found").

The trade-off, stated plainly: **Milkdown is much the smallest project of the three** — 11 npm releases in 2026 against Tiptap's 52 and Lexical's 172, thinner documentation, and a stack where a bug can land in Milkdown or in ProseMirror or in remark. Tiptap is the fallback and loses on nothing but constraint 2, where `@tiptap/markdown` is a first-party bolt-on shipped in October 2025 that its own release notes call early.

## What the spike found

Built, in `poc/rich-text-spike/`: a Vite shell that lazy-imports each candidate at two feature sets, and a jsdom harness that round-trips twenty real descriptions through each and diffs the output against the input. Reports are committed beside it. **Milkdown wins on both axes the spike was run to settle**, so the recommendation stands.

### The chunk, measured

Five Vite builds of the same React shell, differing only in what the lazy chunk imports; figures are gzip level 9 of the emitted chunk.

| Lazy chunk | gzip | brotli |
|---|---|---|
| **Milkdown** `preset-commonmark` | 105.8KB | 92.5KB |
| **Milkdown** `+ preset-gfm` | **130.3KB** | 112.0KB |
| **Tiptap** `starter-kit + markdown` | 135.8KB | 115.9KB |
| **Tiptap** `+ extension-table + extension-image` | **153.3KB** | 130.2KB |

Bundlephobia was close on the first row and useless on the last: Tiptap's table extension reads as 4KB there and costs 17.5KB here. **Milkdown is smaller at both feature sets**, and the gap widens rather than closes with tables.

The shape the numbers actually decide is the budget: the app's entry is **173KB gzip against a 200KB gate**, so no candidate fits inline and the editor's own chunk needs its own budget line. That is the CI check this issue adds.

### Fidelity, measured

Twenty descriptions in, the same text expected out. Both normalise — bullet markers unify, tables get padded — and neither moves the text a second time, so switching between the views repeatedly settles after one pass. What separates them is what does not come back:

| | Milkdown (commonmark + gfm) | Tiptap (starter + markdown + table) |
|---|---|---|
| a table, extension present | padded, kept | padded, kept |
| **a table, extension absent** | **kept as literal text** | **deleted, silently** |
| `a < b`, `?a=1&b=2` | kept | **`a &lt; b`, `&amp;` — entity-corrupted** |
| `<https://…>` autolink | kept | rewritten to `[url](url)` |
| a bare `<b>bold</b>` | kept as text | **promoted to real bold** |
| `<script>`, `<img onerror>` | kept as escaped text | deleted, whole line |
| `\_escaped\_` | kept escaped | **unescaped into emphasis** |
| 60,000 characters | kept | kept |

Three of those are the issue's own rules failing on Tiptap. The deleted table is the exact failure the wider-than-the-toolbar decision exists to prevent — and Tiptap deletes it at the parse step, before any schema of ours can widen. `a < b` is worse than cosmetic: a description that goes near the editor comes back different from the one that was stored, and stays different.

### Two corrections to what is written above

- **Milkdown's `html` node is safe and worth keeping.** It renders raw HTML as escaped text in a `data-type="html"` span, so `<script>` is visible, inert, and still there on the way out. Removing it, as the Security section below advises, would trade that for Tiptap's behaviour: deletion.
- **Both now validate a link's rendered `href`.** `sanitizeLinkHref` in `@milkdown/preset-commonmark` allows `http:`, `https:`, `mailto:`, `tel:` and `ftp:` and renders everything else as `href=""`; Tiptap's link extension does the same. **This does not make Cockpit's own check redundant**: both keep the original scheme in the *stored Markdown*, so `javascript:` typed into a link survives the save and is only defused at render — by that editor, in that version. The allowlist is still Cockpit's, applied where the link is made.

### What the spike does not answer

`@lexical/headless` was not built. Lexical was already third on size and on the growth path, and nothing measured here moves it up.

## What would change this

- ~~The spike showing Milkdown's normalisation losing something Tiptap's does not.~~ **Answered: it lost nothing, and Tiptap lost three things.** Milkdown's documentation costing more agent time than the preset line saves would still flip this to Tiptap.
- **Milkdown going quiet.** A year without releases makes the bus factor real rather than a caveat; the exit is Tiptap, and it is not cheap, because the stored Markdown is portable but the extension code is not.
- **Testability turning out to dominate.** If the selection and toolbar tests land mostly at the Playwright tier and hurt, `@lexical/headless` is worth the two hand-written transformers.
- **Collaborative or multi-device concurrent editing appearing as a requirement.** That is a CRDT question, not a formatting one, and it re-opens the choice from the top.
