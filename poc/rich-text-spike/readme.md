# Rich text spike

The measurements behind "Milkdown" in [docs/rich-text-options.md](../../docs/rich-text-options.md), taken for "Format a description, and edit its source" (issue 160). Outside the pnpm workspace on purpose, like everything in `poc/`: it never runs in CI, and it holds two editors that would otherwise be dependencies of the app.

```bash
cd poc/rich-text-spike
pnpm install --ignore-workspace
pnpm sizes       # five Vite builds; prints the gzip and brotli size of each editor's lazy chunk
pnpm roundtrip   # twenty real descriptions through each candidate; writes the three reports below
```

The reports are committed, so the numbers can be read without running anything:

| File | What it answers |
|---|---|
| `roundtrip-report.md` | what each candidate hands back for each of the twenty descriptions |
| `idempotence-report.md` | whether a second pass moves the text again |
| `html-report.md`, `tiptap-html-report.md` | what each does with raw HTML and with an unsafe link scheme |

**Nothing here is maintained.** It answered the question it was built for; the conclusions live in the options document, and this exists so they can be checked or re-taken against a newer version.
