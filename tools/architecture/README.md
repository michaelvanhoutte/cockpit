# Architecture

Answers, without reading the code: **how is Cockpit built.** Draws it from the checked-out repository
alone — no secrets, and a network only for the previous report's model — as HTML pages with a model beside them. The front page is the services view
(`services-design.html`, [below](#the-services-view)), which ends in **What changed**; beside it are **Modules** and **Dependencies** (`modules.html`),
**Databases** (the table pages) and **Deployment** (on Cockpit's Deployment tab) ("Draw Cockpit's architecture every night, logical and
physical", issue 869).

**What changed**, at the foot of the front page, lists what the areas, marks, dependencies, environments, resources and workflows gained, lost or changed
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
file, or one that predates the rules file, is drawn with the current description and rules, and the section says so; a commit with no schema file is drawn without its
databases; one missing the Worker config or the workflows cannot be drawn.

**Modules**, the first tab of `modules.html`, shows every area of the web app, the API and the packages as a box in the lane of the layer the
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

**Dependencies**, the second tab (`modules-dependencies.html`), is a matrix of those areas in dependency-chain order. A cell counts the files in the
row's area that import the column's area, and the number beside a row is that area's source lines, tests
excluded. How an import is attributed:

| Import | Counted against |
|---|---|
| a relative path | the area holding the file it lands on (`./x`, `./x.js` and a folder's index all resolve) |
| a workspace package by name, or a path inside it | the package's area, by the `name` in its `package.json` |
| an import within the same area, a test file's import, a third-party package | nothing |

A file importing an area twice counts once; type-only imports and re-exports count.

**The order** leaves the fewest import files pointing up, so each area stands above what it imports. It is
searched exactly (every set of areas already placed is weighed) for up to 22 areas, `EXACT_LIMIT` in `src/order.js`,
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
words and packages, what is released on its own, what is a test and which areas everything reads. An area it does not mention still
appears. A new area is described by adding it to a layer; a folder the generator should look in is a
`discover` entry. `pnpm --filter @cockpit/architecture test` fails if the file leaves an area on this
repository's disk undescribed or describes one that is gone.

**Databases** are drawn on [the table pages](#the-table-pages), the register (one D1 database every account shares) and the account store
(one Durable Object per account) apart. Each table is a box listing its columns (type, key, required) and its indexes
(unique, condition); a line goes from a column to the table it points at. CHECK constraints are not drawn. What is
no longer used is drawn red and struck through, with why as its tooltip:

| Evidence | Said as |
|---|---|
| `NO_LONGER_USED` in the store's schema (below) writes it down, with a reason | that reason |
| (register) no query is written against the table or column: the schema queries use does not define it | no query is written against it |
| no source file outside either database's schema files names it, by its SQL name or the name queries use, comments aside | no code names it |
| an index covers a column that is no longer used | it covers that column |

A column of a table already marked is not marked again. The checks work on names: a column read only as part of a
whole row is marked though it is used, and one named like a common word is never marked.

**The schema comes from `apps/api/database-schema.json`**, which `apps/api/tests/integration/db/schema-file.test.ts`
writes from a real register and a real account store once every migration and change has run, so it holds what the
databases end up with and not what the TypeScript describes. The generator reads the file as it reads every other,
since the nightly job has no Workers runtime. A change to either schema fails that test until the file is written
again:

```bash
pnpm --filter @cockpit/api exec vitest run tests/integration/db/schema-file.test.ts -u
```

What the schema writes down as no longer used, with its reason, is `NO_LONGER_USED` in
`apps/api/src/accounts/schema.ts`, for what code still names, such as a column written on every insert; the same test
fails on a name in it that the store no longer has.

**Deployment** is the drawing at the top of Cockpit's Deployment tab (`service-cockpit-deployment.html`), above its columns. It shows:

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
  artifact name and the address on the site it lands at (`/architecture/`).
  No Pages deploy, no box.

Every page names the commit and the date of that commit it was drawn from.

**The Modules page** is `modules.html`, with the Modules and Dependencies tabs above, each area's box marked ↗ to its folder on GitHub. The Modules
diagram is drawn at its natural size in a box that scrolls both ways. The services page and the front page link to it. A run writes
no `index.html`, `context.html`, `register.html`, `account-store.html` or `deployment.html`, so `/architecture/` is not a page. A report whose description file has no `serviceMap` has no front page: its trail starts at the Modules page, which then carries What changed.

## The table pages

`db-register.html`, `db-account-store.html` and `db-harness-monitor.html`, each with a second tab, `db-<key>-columns.html`,
are written beside the report, and a Data card or a store on Cockpit's page opens them. They draw each database's tables left to right: a table
stands one column right of the deepest table it points at, and each pointer is a line from the pointing column's row to
the row it points at, written "→ table.column" on its row. A pointer that skips a column is drawn only while either end is hovered.
Hovering a table shows its lines and fades the tables it has nothing to do with; tables with no relations sit together at the bottom.

- **Relations** keeps the key, pointing and pointed-at rows, and "+ N more columns" opens the other tab.
- **All columns** shows every column with its type and whether it is required, and each table's indexes.
- A table or column no longer used is struck through in red, as in Databases; the Monitor's are never marked, since its schema file records no queries to compare with.
- A table's name (↗) opens the line that defines it on GitHub, at the commit drawn from: the Drizzle definition for the register and the account store, the last migration that creates the table or renames into it for the Monitor.

**The Monitor's tables come from `apps/harness-monitor/database-schema.json`**, which
`apps/harness-monitor/tests/integration/schema-file.test.ts` writes from real D1 once every migration has run, as the
API's does. A migration that changes the schema fails that test until the file is written again:

```bash
pnpm --filter @harness-monitor/worker exec vitest run tests/integration/schema-file.test.ts -u
```

Its SQL declares no foreign key, so the generator infers them: a column named like the single-column key of another table
of the same family (the part of the name before its first underscore) points at that table, as `stability_jobs.run_id` does at
`stability_runs`. The page says so. A missing or unreadable file fails the run as the API's does.

## The Design tab

`service-<id>-design.html` (`service-cockpit-design.html`, `service-harness-monitor-design.html`, `service-android-widget-design.html`) and `services-design.html` show the intended design alone, with no line from the code, drawn from the rules file. The services page and each service open on it, and its tabs are Design, Logical and, where the service deploys, Deployment.

| On the page | Is |
|---|---|
| the drawing | the layers as boxes with their parts; one arrow per allowed call, carrying only its number, which jumps to its card; the dashed lines are how a caller reaches it |
| the count under the title | N rules, how many agreed, drafted and questions: a call, a rule in `rules` and an accepted deviation each count one |
| a group | the calls from one layer, opened by a sentence ("Business logic calls Data, Connectors and Outside services, and nothing else."); a layer that calls nothing has none |
| a card | the rule's number, from → to, its mark, its reason and where in `docs/architecture.md` it was read |
| the other rules | `rules` of the rules file as cards of their own, marked with a dot because the drawing has no arrow for them |
| what is not allowed | the `not allowed` sentences, then "Anything else the drawing does not draw." |
| accepted deviations, callers | the `accepted` entries with reason, files and mark; one row for each `reached by` caller |

A rule's mark is **agreed** when the rules file sets `agreed: true`, a **question for you** when it carries a `question` (or no reason), and **drafted, not agreed** otherwise. A service the rules do not rule inside (the Harness Monitor) has no layers to draw: its page holds its rules, its callers and the count. The widget draws its box with the two calls it may make. The services page draws the services and the `between services` rules that name a `from` and a `to` as numbered arrows; a rule about every service is a card with a dot. Every reason, source and question is escaped, so one holding `<` or `&` is shown as written.

## Cockpit's logical page

`service-cockpit.html`, the Logical tab, draws the design Cockpit is meant to have as nested layers, with the code's own lines laid over it. The report links the services page, which opens on its Design tab; each service's Design tab (next section) comes before Logical.

**The design is `docs/architecture.yml`; `description.yml` is how it is drawn.** The rules file holds the services and the calls between them, Cockpit's layers with their parts, what each layer may call (`calls`), what is not allowed (`not allowed`), the accepted deviations and who reaches Cockpit (`reached by`). The tool reads it with its own reader (`src/rules.js`), since the nightly run installs the tool alone, and joins it to the `design` section of `description.yml` (`src/compose.js`). That section keeps only where each box sits (`row`, `share`, `alignedWith`, `drawInside`, `href`), the `marker` that finds a store or an outside service in the code, the `noLine` folders, and for each caller the code it is looked for in. The two name the same ids: a layer, a part or a caller in one and not the other fails the run and names it. A part's name, description and folders are the rules file's `name`, `what` and `code`; a layer's title is its `name`. A chip with a `caller` is a box for something that reaches Cockpit and is no part of it, named as `reached by` names it.

| Line | Means |
|---|---|
| grey, labelled with a file count | the design allows the pair of layers and the code uses it: one line per pair of layers |
| red, numbered, chip to chip | the code does what the design does not allow; its row below lists each file at the line that makes it |
| grey, marked ✓ | the code does what the design does not allow, and the design accepts it with a reason for every file that makes it |
| dotted | the design allows the pair of layers and no file uses it |
| dashed blue | how a caller talks to the service, declared, and looked for in the caller's own code where this repository holds it |

A line between two components in one layer is counted on the layer's title and not drawn, unless the layer sets `drawInside`.

**Accepting a deviation** is a pull request to the `accepted` list in `docs/architecture.yml`: each entry names the two components
(`from`, `to`), the `files` it covers and the `reason`. It is judged per file. A line is grey and listed under "Accepted, with
a reason" when the entry names every file that makes it; a file it does not name leaves the line red, its row naming the new
files. An entry no deviation on its pair needs any more (the line is gone, a file was renamed, or the design now allows it) is
listed as "No longer needed" and fails nothing; an entry naming a component the design lacks, or giving no reason, fails the run.
A red or ✓ circle, and each row's "Scope a fix" or "Reconsider" button, open a dialog with the files linked to their lines and
a `/scoping` prompt to copy. The prompts are built with the page and carried in it as data; copying runs in the browser and
sends nothing. The page's one inline script serves that dialog, and a page with no deviation carries neither.

**CI fails on every red line not listed as a known breach** (the rule with `check: layer-calls`, `src/layer-calls.js`, run by
`tests/lint/layer-calls.test.mjs`). The `known breaches` list in `docs/architecture.yml` names, per file, red lines CI tolerates
until they are fixed; the page still draws them red. An entry in `accepted` or `known breaches` naming a file that no longer
makes its call fails, and the import check fails a pull request whose known breaches grew against the merge base.

**Evidence** is one import (resolved the way Dependencies resolves it) or one marker match per file, with its line. A
store's or outside service's `marker` is a regular expression searched in the code of every component; a match on a
comment line is not evidence.

**Placement** is recorded in `model.json` under `logical.placement` and shown on the page: a folder no component names, a
component naming a folder that is gone, and a folder in two components. The `Logical` tests over this repository fail on any.
A folder read by nearly everything goes in `noLine` instead.

**Other services** are the `otherServices` list of `description.yml`, each with a `design` that says where its code is, and drawn
on `service-<id>.html` (today `service-harness-monitor.html`, in `model.json` under `services`). A service that keeps its
files in one folder names file-name patterns instead of folders: `in` is the folder (its files directly, not its subfolders)
and `files` the patterns, where `*` is any run of characters in the name. Placement is by file: a source file no pattern
matches, a file two components' patterns match and a pattern matching nothing are recorded in `placement` as a folder is, and
fail the same test. A store or outside service with an `href` opens that page of its own (the Monitor's store opens its
database page, its Cockpit box opens Cockpit's page). A page of another service shows the acceptances and callers sections
once it has an acceptance or a caller whose code this repository holds.

**Only Cockpit is ruled inside.** The rules file has no layers for the Harness Monitor or the Android widget, so they are drawn by their boundary. The Monitor keeps how it is reached (`reached by`, matched to the drawing's callers by name and by the part they reach, `at`), and every line between its layers is allowed, so none is red: the placement check still places each source file in exactly one component, because that is how its lines are found. The widget keeps what it may call (`calls`), which must be the drawing's other layers (Cockpit and the phone), and the lines among its own parts are not ruled.

**The Android widget** is such a service, `service-android-widget.html`, drawn as its box from Cockpit's diagram opened to show
its parts (a layer of `kind: service`), with Cockpit's API layer beneath as a dotted box (`kind: context`: its components are
drawn for their ↗ to a folder, and nothing places them). The widget chip on Cockpit's page opens it. Its files are Kotlin, so the
design names `extensions: ['.kt']` and `findLines: names`: a part uses another when one of its files names a class or function
the other's files define, comments left out and a part naming its own class drawing nothing. The page says so, since a common
word used as a name can draw a line that is not there. A caller with `code.addresses` (a regular expression whose first group
is an address) is found by the addresses its code calls, and its line is labelled with them; `code.only` limits it to named files.
Its table lists every line with each file at its line.

A component marked ↗ opens its folder (or, for patterns, its first file, the tooltip listing the rest) on GitHub at the commit the page was drawn from, and each file listed opens at its
line. The page knows the repository from `GITHUB_REPOSITORY`, which GitHub Actions sets (set it by hand, as `owner/name`, to get the links in a
local run); without it, or without a commit, it links nothing.

## The services view

`services-design.html` (the services page's Design tab; `services.html` is its Logical tab) is the report's front page and the way into every other page of this view. Every crumb trail starts at "Architecture", which is that page. It is built from two sections of `description.yml`, written by
hand, from `docs/architecture.yml` and from what the model already holds. The services in `serviceMap.services` are the services of the rules file, a call from one service to another in `serviceMap.calls` is one of its `between services` rules and the reverse, and the folders a service owns (`serviceMap.owns`) are its `code`; `description.yml` keeps the packages it is imported by.

**The services page** draws Cockpit and the Harness Monitor as boxes, who uses them (`serviceMap.clients`), the lines between
them (`serviceMap.calls`) and the outside services their designs name. A call with `foundBy` is looked for in the caller's own
code, as the design's caller of that name is, and is grey when found. A box's badge, "N off the design", counts only the red lines
on its own page (an accepted line is not one), links to that table, and is absent at none. Below the drawing:

| Section | Says |
|---|---|
| Between services | red, one numbered line each, when a file imports another service's code: a relative path into a folder another service owns, or a package it is imported by (`serviceMap.owns`, the folders from the rules file), read from the source files the model has the text of. Red too when two services' configs bind a store of the same kind and name. Else "No file imports another service's code." and "No store is used by two services." |
| What deploys on its own | each service's workflows, environments and stores, from the Deployment tabs |

**Design, Logical and Deployment** switch on Cockpit, the Monitor and the widget. A Deployment tab is one column per environment
(runs on, shipped by with the workflow linked, settings, secrets by name, storage, queues, other bindings). It comes from the
`deployments` section: a Worker names its `config`, read exactly as Cockpit's deployment drawing reads it (so each
environment `apps/api/wrangler.jsonc` or the Monitor's config declares is a column, and the cron and assets are inherited
the same way), and the file declaring its bindings, from which the names of secrets are read. A secret is only ever a name: a
setting named like one (`SECRET`, `TOKEN`, `KEY`, `SID`, `PASSWORD`) shows `(set)` where its value would be. What ships an environment is
what the generator reads the workflows as deploying it, unless `shippedBy` names the workflows. A service that is not a Worker
(the widget) lists its environments by hand, with the workflow that ships each, or the words when none does. Cockpit's tab also
carries the deployment drawing (see Deployment above).

**The generator credits `deploy-harness-monitor.yml` with deploying Cockpit's production**, because the workflow runs
`wrangler deploy` with no environment, which the reading takes as the top level of Cockpit's config. Cockpit's Deployment tab
shows it as the drawing does. The Monitor's own tab names its workflow with `shippedBy`.

**Layer pages**: a design layer with an `href` (and no stores) is a page of its own, titled by a link in Cockpit's diagram. Its
Modules tab is `modules.html`'s Modules diagram cut to the folders the layer's components name, each box marked ↗ to its folder on GitHub, and its
Dependencies tab the same cut as a matrix; an import out of the layer is on neither. A layer holding stores is a page of
cards instead, one per store with who uses it, a database's card opening its table page. A store with an `href` opens its table page from the diagram.

**A path written between backticks in a description's intro, or as `<code>` in a page's prose, links to it on GitHub at the commit**
when it starts with `apps/`, `packages/`, `tools/`, `scripts/`, `docs/` or `.github/`.

## Reading it without running it

The `Architecture` job of [`.github/workflows/nightly.yml`](../../.github/workflows/nightly.yml) builds it
once a night, and by hand from the Actions tab when a night was missed. It uploads the pages and
`model.json` as the `architecture-report` artifact, and that same run's `Publish` job takes it live at
**<https://michaelvanhoutte.github.io/cockpit/architecture/services-design.html>**, the one report that stays on GitHub
Pages; the others are pages of the Harness Monitor, which the front page links when given its address
(`--monitor`, from the repository variable `HARNESS_MONITOR_URL`). A missing artifact costs this page
and never the redirects beside it.

The job installs this package's own dependencies (`yaml` and `jsonc-parser`, so neither file format is
parsed by hand) and nothing else; it needs no token. It checks out the whole history, so the commit the live report
names can be drawn, and fetches the live `model.json` from the site, the only thing it fetches; a failed fetch
costs the What changed section, never the night.

## Running it

```bash
pnpm architecture                          # from the repo root — writes the pages and model.json into tools/architecture/out/
pnpm --filter @cockpit/architecture model  # the model alone, at out/model.json
```

```bash
cd tools/architecture
node src/cli.js                            # the repository this tool is in
node src/cli.js --out /tmp/report          # a folder of your choice instead of out/; the model is always in it as model.json
node src/cli.js --model somewhere/model.json   # also writes the model to this path
node src/cli.js --monitor https://monitor.example   # links the harness reports at the Monitor's pages
node src/cli.js --root ../other-checkout   # a different checkout
node src/cli.js --previous https://michaelvanhoutte.github.io/cockpit/architecture/model.json   # What changed against the live report
node src/cli.js --help
```

**A file it cannot read fails the run**: a Worker config that is not JSONC, a workflow or the description
file that is not YAML (or is missing what it must hold), a schema file that is not JSON or holds no list of databases, or a file that is missing exits non-zero and writes no page and no model, so the
previous report stays live. Nothing is written until all are built. `--json` writes the model alone, as `model.json` in the folder.

## How a page gets built

```
readCheckout(root)  →  buildModel(...)  →  compareWithPrevious(...)  →  the pages (model, { comparison })  →  out/*.html
   (src/read.js)        (src/model.js)       (src/compare.js, src/diff.js)   (src/render/)                       (out/model.json)
```

`read.js` is the only file that touches the checkout, git, the previous model and the earlier commit's checkout; `diff.js` is a pure function of two models; `model.js` (with `description.js`,
`scan.js` and `modules.js`) is a pure function of the file texts, the areas read off disk and the commit it
is told; `render/` draws what it is handed.

## Tests

`pnpm --filter @cockpit/architecture test` runs both tiers: the model, the Modules, Dependencies, table-page and services views and the front page under `tests/unit/`,
and the CLI over a fixture repository and over this repository's own checkout, with the workflow wiring
read from `nightly.yml` and `publish.yml` and the areas found by the file's rules, under `tests/integration/`.
