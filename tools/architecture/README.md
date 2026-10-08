# Architecture

Answers, without reading the code: **how is Cockpit built.** Draws it from the checked-out repository
alone — no network, no secrets — as one HTML page and a model beside it. This slice draws **Context**,
**Modules** and **Deployment**; the other views of the report ("Draw Cockpit's architecture every night,
logical and physical", issue 869) are later slices.

**Context** shows the people and outside services [`description.yml`](description.yml) declares, around Cockpit.

**Modules** shows every area of the web app, the API and the packages, each with the one-line description
the file gives it, in the layer the file puts it in. Areas are found on disk by the file's `discover`
rules: the web app's `src` as one area, each folder of the API's `src` (and its root files as one more),
and each package under `packages/` and `packages/connectors/`. A folder holding only tests is not an area.
The marks are shown and nothing fails on them:

| Mark | When |
|---|---|
| undescribed | an area on disk the file does not describe |
| gone | an area the file describes that is no longer on disk |
| names a source | a core area whose code uses a declared source's name, with the files that do |
| imports beyond the SDK | a connector package importing another workspace package, or a path out of itself |

A name counts in identifiers, strings and JSX text and never in a comment, as a whole word in any case:
`gmail`, `GMAIL`, `GmailMark` and `gmail_check` name Gmail; `gmailish` does not. The words of a source
are its own in the file, so a source whose name is also plain English (`teams`) is declared by what only
the product is called. Teams is not declared today: its connector sits behind the SDK, and the core says
"Microsoft Teams" only as a display name.

**The description file holds the wording, the layout and the rules**, and the generator none: the layers
and their order, each area's description and role (`core`, `connector` or `other`), the sources and
their words, what is a test, and the people and services of Context. An area it does not mention still
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

## Reading it without running it

The `Architecture` job of [`.github/workflows/nightly.yml`](../../.github/workflows/nightly.yml) builds it
once a night, and by hand from the Actions tab when a night was missed. It uploads the page and
`model.json` as the `architecture-report` artifact, and that same run's `Publish` job takes it live at
**<https://michaelvanhoutte.github.io/cockpit/architecture/>**, beside the test explorer, the
[CI stability page](../ci-stability/README.md), the [lead-time page](../lead-time/README.md) and the
[test-selection page](../selection/README.md). A missing artifact costs this page and never the site.

The job installs this package's own dependencies (`yaml` and `jsonc-parser`, so neither file format is
parsed by hand) and nothing else; it needs no token.

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
node src/cli.js --help
```

**A file it cannot read fails the run**: a Worker config that is not JSONC, a workflow or the description
file that is not YAML (or is missing what it must hold), or a file that is missing exits non-zero and writes neither page nor model, so the
previous report stays live. Nothing is written until both are built.

## How a page gets built

```
readCheckout(root)  →  buildModel(...)  →  renderHtml(model)  →  out/index.html
   (src/read.js)        (src/model.js)       (src/render/)        (out/model.json)
```

`read.js` is the only file that touches the checkout and git; `model.js` (with `description.js`,
`scan.js` and `modules.js`) is a pure function of the file texts, the areas read off disk and the commit it
is told; `render/` draws what it is handed.

## Tests

`pnpm --filter @cockpit/architecture test` runs both tiers: the model, the Context and Modules views and the page under `tests/unit/`,
and the CLI over a fixture repository and over this repository's own checkout, with the workflow wiring
read from `nightly.yml` and `publish.yml` and the areas found by the file's rules, under `tests/integration/`.
