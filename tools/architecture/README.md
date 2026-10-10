# Architecture

Answers, without reading the code: **how is Cockpit built.** Draws it from the checked-out repository
alone — no secrets, and a network only for the previous report's model — as one HTML page and a model beside it. It draws **What changed**,
**Context**, **Modules**, **Dependencies** and **Deployment** ("Draw Cockpit's architecture every night, logical and
physical", issue 869).

**What changed** lists what the areas, marks, dependencies, environments, resources and workflows gained, lost or changed
since the commit the live report was drawn from, with the previous report's model read from `--previous` (a file or an
address). Only that model's commit is used: the generator draws that commit again and diffs the two models, so a change
to the generator alone lists nothing, and a night missed loses nothing, the comparison being with whatever was last
published. A row is the change, where it is and a flag; these are called out and listed first:

| Flag | When |
|---|---|
| connector file in the core | a core file whose name carries a connector's words arrives; one leaving (moved into the connector's package) is listed, not called out |
| new breach | a connector package imports beyond the SDK, or in more files |
| new upward import | an import now points up the dependency chain, as the half of a new cycle or on its own |
| undescribed, gone | an area is new and the description file does not mention it, or is described and no longer on disk |

File counts, line counts and a cell's number of importing files move with every merge and are not changes. Where there
is nothing to compare the section says which and lists nothing, and the run goes on:

| Situation | The page says |
|---|---|
| no `--previous`, or no live report yet (no such file, a 404) | the first report; or that no earlier report was given |
| the model cannot be fetched or read, or names no commit | there is nothing to compare, and why |
| its commit is not in this checkout's history, or cannot be drawn | the same |
| no merge since | nothing changed |

The earlier commit is checked out into a temporary `git worktree`, removed afterwards. A commit with no description
file is drawn with the current one, and the section says so; one missing the Worker config or the workflows cannot be
drawn.

**Context** shows the people and outside services [`description.yml`](description.yml) declares, around Cockpit.

**Modules** shows every area of the web app, the API and the packages as a box in the lane of the layer the
file puts it in (its description is the box's tooltip). A box sits on the row below everything that imports it,
by downward imports alone, and only the shortest chain is drawn: an import a longer chain of downward imports
already covers is left out. Each arrow is labelled with its file count. A cycle draws its downward half as an
ordinary arrow and its upward half in red, labelled a tie where the order could not decide it. Areas are found on disk by the
file's `discover` rules: the web app's `src` as one area, each folder of the API's `src` (and its root
files as one more), and each package under `packages/` and `packages/connectors/`. A folder holding only tests is not an area.
The marks are shown and nothing fails on them:

| Mark | When |
|---|---|
| undescribed | an area on disk the file does not describe |
| gone | an area the file describes that is no longer on disk |
| imports beyond the SDK | a connector package importing another workspace package, or a path out of itself |

**Connectors** are a lane of their own with one box per source the file declares, solid when the `package` it names is on
disk, dashed red when it names none or the package is gone. A package a source names is drawn as that connector's box and not
again as an area. A core file is a connector's when its **file name** carries the source's words as a whole word, in any case:
`gmail-check.ts`, `gmail.ts` and `ConnectGmail.tsx` are Gmail's; `gmailish.ts` is not, and a file only mentioning
the name inside is nothing. Each core area holding such files gets one dashed red line from the connector, labelled with how
many; files inside the connector's own package are not counted, and neither are those `exemptFromSources` lists, the
composition root, the one core file that names connectors.

**Released together** is an outline round every lane for each Worker the Worker config deploys (environments running the same
`main` are one Worker), and `releasedOnItsOwn` in the file lists each part shipped apart, drawn as a box outside the outline.

**Dependencies** is a matrix of those areas in dependency-chain order. A cell counts the files in the
row's area that import the column's area, and the number beside a row is that area's source lines, tests
excluded. How an import is attributed:

| Import | Counted against |
|---|---|
| a relative path | the area holding the file it lands on (`./x`, `./x.js` and a folder's index all resolve) |
| a workspace package by name, or a path inside it | the package's area, by the `name` in its `package.json` |
| an import within the same area, a test file's import, a third-party package | nothing |

A file importing an area twice counts once; type-only imports and re-exports count.

**The order** leaves the fewest import files pointing up, so each area stands above what it imports. It is
searched exactly (every set of areas already placed is weighed) for up to 18 areas, `EXACT_LIMIT` in `src/order.js`,
and by a greedy order improved by moving one area at a time beyond that; the page says which it used, and a
tie goes to the order the layers list. `readByEveryone` in the description file lists the areas every other
area reads (today the API's root files, which hold `env.ts`): they stand last, every cell on their row or
column is muted, and their imports never count. `pins` lists `{ above, below }` pairs for where the computed order is wrong;
an unknown area, an area read by everyone, or pins that chase each other fail the run like any description-file error.

| Cell | Shown as |
|---|---|
| an import of an area above (a cycle's half back up the chain, or a one-way import under a pin) | red |
| the other half of a cycle | an ordinary import, outlined in red |
| an import of an area below, with none back | an ordinary import |

A cycle of two halves with the same number of files is said to be one the order could not decide, unless a pin
does. A line under the matrix names the cycles. Dynamic `import()` is read like any other
import, and a path no area holds is dropped.

**The description file holds the wording, the layout and the rules**, and the generator none: the layers
and their order, each area's name, description and role (`core`, `connector` or `other`), the sources, their
words and packages, what is released on its own, what is a test, which areas everything reads, and the people and services of Context. An area it does not mention still
appears. A new area is described by adding it to a layer; a folder the generator should look in is a
`discover` entry. `pnpm --filter @cockpit/architecture test` fails if the file leaves an area on this
repository's disk undescribed or describes one that is gone.

**Deployment** shows:

- **Every environment `apps/api/wrangler.jsonc` declares**, with each resource it binds under its own
  name: D1 database, Durable Object, R2 bucket, KV namespace, queue (producer and consumer), static
  assets, cron trigger and the AI binding. The top level of the file is production, the environment
  Wrangler deploys without `--env`; `local` is drawn as local development.
- **Wrangler's inheritance rules**: the cron and the static assets are inherited from the top level
  and marked so; a binding an environment does not declare is one it does not have. A binding kind
  the generator does not know is drawn under its raw kind rather than dropped.
- **Every workflow in `.github/workflows/`**, with what starts it ("every merge", "by hand", a
  schedule's time, "called by" the workflows that call it) and the environment its Wrangler deploy
  names, if any.
- **GitHub Pages**, read from the workflow that deploys it: each report it downloads, with the
  artifact name and the address on the site it lands at (`/`, `/stability/`, `/architecture/`, ...).
  No Pages deploy, no box.

Every page names the commit and the date of that commit it was drawn from.

**Each diagram opens full size.** Clicking Context, Modules or Deployment opens `context.html`, `modules.html` or
`deployment.html`, written beside the page, in a new tab: the same drawing at its natural size in a box that scrolls
both ways, with the report's styles and a link back. The page keeps each fit to the column and carries no script.

## Reading it without running it

The `Architecture` job of [`.github/workflows/nightly.yml`](../../.github/workflows/nightly.yml) builds it
once a night, and by hand from the Actions tab when a night was missed. It uploads the page and
`model.json` as the `architecture-report` artifact, and that same run's `Publish` job takes it live at
**<https://michaelvanhoutte.github.io/cockpit/architecture/>**, beside the test explorer, the
[CI stability page](../ci-stability/README.md), the [lead-time page](../lead-time/README.md) and the
[test-selection page](../selection/README.md). A missing artifact costs this page and never the site.

The job installs this package's own dependencies (`yaml` and `jsonc-parser`, so neither file format is
parsed by hand) and nothing else; it needs no token. It checks out the whole history, so the commit the live report
names can be drawn, and fetches the live `model.json` from the site, the only thing it fetches; a failed fetch
costs the What changed section, never the night.

## Running it

```bash
pnpm architecture                          # from the repo root — writes tools/architecture/out/index.html
pnpm --filter @cockpit/architecture model  # the model instead, at out/model.json
```

```bash
cd tools/architecture
node src/cli.js                            # the repository this tool is in
node src/cli.js --model out/model.json     # writes the page and, beside it, the model
node src/cli.js --root ../other-checkout   # a different checkout
node src/cli.js --previous https://michaelvanhoutte.github.io/cockpit/architecture/model.json   # What changed against the live report
node src/cli.js --help
```

**A file it cannot read fails the run**: a Worker config that is not JSONC, a workflow or the description
file that is not YAML (or is missing what it must hold), or a file that is missing exits non-zero and writes no page and no model, so the
previous report stays live. Nothing is written until all are built. `--json` writes the model alone.

## How a page gets built

```
readCheckout(root)  →  buildModel(...)  →  compareWithPrevious(...)  →  renderHtml(model, { comparison })  →  out/index.html
   (src/read.js)        (src/model.js)       (src/compare.js, src/diff.js)   (src/render/)                  (out/model.json)
```

`read.js` is the only file that touches the checkout, git, the previous model and the earlier commit's checkout; `diff.js` is a pure function of two models; `model.js` (with `description.js`,
`scan.js` and `modules.js`) is a pure function of the file texts, the areas read off disk and the commit it
is told; `render/` draws what it is handed.

## Tests

`pnpm --filter @cockpit/architecture test` runs both tiers: the model, the Context, Modules and Dependencies views and the page under `tests/unit/`,
and the CLI over a fixture repository and over this repository's own checkout, with the workflow wiring
read from `nightly.yml` and `publish.yml` and the areas found by the file's rules, under `tests/integration/`.
