# Architecture

Answers, without reading the code: **how is Cockpit built.** Draws it from the checked-out repository
alone — no network, no secrets — as one HTML page and a model beside it. This slice draws the
**Deployment** view; the other views of the report ("Draw Cockpit's architecture every night, logical
and physical", issue 869) are later slices.

The Deployment view shows:

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
- **The commit and the date of that commit** the page was drawn from.

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

**A file it cannot read fails the run**: a Worker config that is not JSONC, a workflow that is not YAML
or has no `on:`, or a file that is missing exits non-zero and writes neither page nor model, so the
previous report stays live. Nothing is written until both are built.

## How a page gets built

```
readCheckout(root)  →  buildModel(...)  →  renderHtml(model)  →  out/index.html
   (src/read.js)        (src/model.js)       (src/render/)        (out/model.json)
```

`read.js` is the only file that touches the checkout and git; `model.js` is a pure function of the file
texts and the commit it is told; `render/` draws what it is handed.

## Tests

`pnpm --filter @cockpit/architecture test` runs both tiers: the model and the page under `tests/unit/`,
and the CLI over a fixture repository and over this repository's own checkout, with the workflow wiring
read from `nightly.yml` and `publish.yml`, under `tests/integration/`.
