# Coverage Explorer POC

Derives a per-node test coverage model from the repository and renders it as a
clickable explorer: a tree of nodes crossed with the seven test levels of
[docs/testing-strategy.md](../../docs/testing-strategy.md), where each cell says
whether that node **owes** a test at that level and whether it **has** one.

The reasoning behind the shape, and the options that were rejected, are in
[docs/coverage-reporting-options.md](../../docs/coverage-reporting-options.md).
This is the prototype for the preferred options in that document: decision 1.4
(tree by level matrix), decision 2.3 (derive nodes from existing artifacts) and
decision 3.3 (the three-signal rule).

**Nothing here is wired into the build.** `poc/` is outside the pnpm workspace,
so `pnpm test`, `pnpm build`, `pnpm typecheck` and CI do not see it. It cannot
break the repository, and it can be deleted in one `rm -rf` if the approach is
not kept.

## Running it

```bash
cd poc/coverage-explorer
npm install          # its own node_modules; the repo's pnpm store is strict
npm run build        # writes out/index.html
npm run model        # writes out/model.json instead, for another consumer
npm run check        # lists unmet obligations on stdout
```

Open `out/index.html` in a browser. It is one self-contained file with no
external requests.

Node 22+, one dependency (`typescript`, for the compiler API).

## How the code is separated, and why

The shape of the report is the least settled part of this, so the boundary that
matters most is between deriving the model and drawing it. It is enforced by
imports, not by convention:

```
src/
├── model.js          THE CONTRACT. Types, the state vocabulary, the roll-up rule.
│                     Imports nothing. Both halves depend only on this.
│
├── analyze/          Repo in, Model out. Knows TypeScript, pnpm and the repo
│   ├── nodes.js        layout. Knows nothing about HTML.
│   ├── signals.js      Never imports from render/.
│   ├── tests.js
│   └── index.js
│
├── policy/           The only files that encode judgment rather than measurement.
│   ├── obligations.js  What the measurements oblige. About 100 lines, and it
│   │                   should stay short enough to read in one sitting.
│   └── annotations.js  Places a human overrode the rule, each with its reason.
│
├── render/           Model in, HTML out. Knows nothing about how the model was
│   ├── html.js         produced. Never imports from analyze/ or policy/.
│   ├── styles.css      Real files rather than template literals, so both stay
│   └── client.js       editable.
│
└── cli.js            The only place the two halves meet.
```

Three consequences worth stating, since they are the point of the layout:

- **Replacing the visualization** means adding a file under `render/` and one
  line in `cli.js`. If the matrix turns out to be wrong and a treemap is right,
  nothing in `analyze/` changes.
- **Replacing the derivation** means changing `analyze/`. The renderer does not
  care whether nodes came from the workspace globs or from somewhere else.
- **`--json` is the real escape hatch.** The model is the deliverable; the HTML
  is one consumer of it. A CI check, a diff between commits, or a completely
  different front end can all read `out/model.json` without any of this code.

If you find yourself adding a field to `model.js` to make one particular
rendering easier, that is the boundary being eroded.

## What it actually measures

**Nodes** come from four sources that the repo already maintains, so there is no
list to keep updated:

| Source | Produces |
|---|---|
| `pnpm-workspace.yaml` globs | package nodes, classified by their config files |
| Layer folders from architecture §6.1 | layer nodes inside a package |
| `packages/connectors/*` | one node per connector, all with the same obligations |
| `commandSchemas` in `packages/shared` | the capability axis |

**Signals** come from one pass with the TypeScript compiler API: branch count as
a cyclomatic proxy, purity from the import graph and a small list of impure
globals, and fan-in from the same graph. Consequence tier is set per layer in
`policy/obligations.js`, never per file.

**Actuals** come from reading the test files, not from running them. A test
file's imports say which modules it exercises and which of their exports it
touches, which is enough to separate "tested" from "partially tested" without
executing anything. That is deliberate: a report that needs the suite to run is
a report that stops working the moment the suite breaks.

## Known limitations

These are real, and they are why this is a POC rather than a tool:

- **Branch count is a crude proxy.** A branchless module can still be wrong.
  `packages/shared/ids.ts` is the case in point: straight-line bit manipulation,
  zero branches, and obviously worth testing. The analyzer handles it by always
  reporting tests that exist, even where the rule would have obligated nothing,
  but the rule alone would have missed it.
- **Structural obligations are invisible to the rule.** Nothing about branches,
  purity or fan-in can express "the Drizzle schema should agree with the
  migrations". That one is an annotation, and there will be others.
- **Purity is decided from imports.** A module that receives an impure
  dependency as a parameter reads as pure. In this repo that is rare, because
  the §6.1 import rule already separates the layers.
- **Test attribution is per file, not per test.** A test file importing two
  modules attributes its full count to both rather than splitting it. The number
  is a signal of attention, not a budget.
- **Only TypeScript is analyzed.** The bash assertions under `scripts/` are
  hand-declared in `policy/annotations.js` with their counts, and marked as such
  in the output.
- **Reach is measured by named imports.** A test using `import * as m` reads as
  reaching nothing.

## The gate this is not

`npm run check` prints unmet obligations and exits zero. Turning that into a
real CI gate is decision 4 in the options document, and it is deliberately not
done here: the moment this blocks a merge, the cheapest route to a green build
is to argue a node into "not applicable" rather than test it. The mitigation is
already in place structurally (applicability is derived, and overrides live in
one small reviewed file), but it should be lived with for a while before
anything depends on it.
