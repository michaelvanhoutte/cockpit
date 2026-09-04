# Rich text for an Item description

**Status: recommended, not decided.** The recommendation below turns on one number nobody has measured — see "What would establish the missing numbers".

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
| **Milkdown** (ProseMirror + remark) | re-serialised, normalised | preset swap (`preset-gfm`); images already in `preset-commonmark` | 104KB (`@milkdown/preset-commonmark` 7.22.1) | an `html` node exists in the preset — leave it out | needs Range mocks; selection untestable |
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

Tiptap and Lexical both make the unsafe case unrepresentable rather than sanitising it: a node absent from the schema (or from Lexical's registered node list) cannot exist in the document, so pasted `<script>` has nowhere to go, and both render into DOM they construct — no `dangerouslySetInnerHTML` anywhere. Milkdown is the same machinery with one exception worth naming: its CommonMark preset registers an `html` node, so it must be removed rather than relied on to be empty.

**None of the three validates a link's href.** `javascript:alert(1)` typed into the link dialog is accepted by all of them. Whichever wins, the URL scheme allowlist is a mark-level input rule Cockpit writes, tested at F1 — it is not free anywhere.

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
3. **It is the smallest of the three**, at 104KB against Tiptap's 105 + 18.

The trade-off, stated plainly: **Milkdown is much the smallest project of the three** — 11 npm releases in 2026 against Tiptap's 52 and Lexical's 172, thinner documentation, and a stack where a bug can land in Milkdown or in ProseMirror or in remark. Tiptap is the fallback and loses on nothing but constraint 2, where `@tiptap/markdown` is a first-party bolt-on shipped in October 2025 that its own release notes call early.

## What would establish the missing numbers

Everything above is published figures; nothing here has been built. One spike settles it: a Vite entry that lazy-imports each of Milkdown and Tiptap at the first formatting set, then again with tables and images, and read the real chunk sizes off the CI bundle report. Round-trip twenty real descriptions — the ones with pasted Notion tables — through each and diff the source view against the input.

## What would change this

- **The spike showing Milkdown's normalisation losing something Tiptap's does not**, or its documentation costing more agent time than the preset line saves. Either flips this to Tiptap.
- **Milkdown going quiet.** A year without releases makes the bus factor real rather than a caveat; the exit is Tiptap, and it is not cheap, because the stored Markdown is portable but the extension code is not.
- **Testability turning out to dominate.** If the selection and toolbar tests land mostly at the Playwright tier and hurt, `@lexical/headless` is worth the two hand-written transformers.
- **Collaborative or multi-device concurrent editing appearing as a requirement.** That is a CRDT question, not a formatting one, and it re-opens the choice from the top.
