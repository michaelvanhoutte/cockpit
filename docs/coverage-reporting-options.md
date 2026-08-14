# Test Coverage Reporting Options

**Status:** options document, no decision committed. Written from the audit of commit `a0ad763`.

## Goal

Answer, without reading the code, two questions about any part of Cockpit:

- Which test levels does this part **owe**, and which does it **have**?
- Which parts owe something they do not have?

The audit that prompted this produced a single pyramid for the whole repository. That was enough to show the shape of today's suite (one populated level out of six), but it does not survive the next phase of the project. Once `packages/connectors/*` exists, every connector is its own testable unit with its own unit tests, its own recorded fixtures and its own scheduled contract test, per [architecture.md](architecture.md) §6.2. A single pyramid averages all of that into one picture and hides exactly the thing worth seeing.

So the reporting question is really three separate decisions, taken in order:

1. What shape does the report take?
2. Where do the nodes in that shape come from?
3. How do we decide that a node owes tests at a given level?

Each is treated below. Related: [testing-strategy.md](testing-strategy.md) defines the six levels and the obligations; this document is only about making them visible.

---

## Finding that constrains all three decisions

The test levels do not all attach at the same height of a structural tree:

| Level | Attaches to |
|---|---|
| L1 unit, F1 frontend unit | Leaves: individual modules and components |
| L2 integration, F2 service-frontend | Whatever owns infrastructure: a deployable service |
| Contract (§3.3) | Boundaries: one per third-party integration |
| L3 system | The composition of services, near the root |
| F3 end-to-end | **Capabilities**, which cut across the tree entirely |

The last row is the awkward one. "A user can snooze an item" touches a component, a hook, a route, a handler and a table. It does not belong to any node. Any option chosen below has to carry a second, capability-indexed axis alongside the structural one, or it will silently drop the mandatory coverage rule in testing-strategy §5.1.

Cockpit already has that list in machine-readable form: `commandSchemas` in `packages/shared/src/commands.ts`.

---

## Decision 1: the shape of the report

### Option 1.1: Drill-down pyramids

One pyramid per node. Click a node to descend into its children, breadcrumb back up.

**Pros**

- Keeps the mental model the current audit already established, at zero re-learning cost.
- The pyramid is genuinely the best shape for reading a single component: it puts the levels in cost order and makes an inverted suite obvious at a glance.
- Trivial to explain to someone who has read the testing strategy.

**Cons**

- No overview. A gap is invisible until you click into the node that has it, so finding the worst node means visiting every node.
- That is the "read the code" problem restated, which is the problem this is supposed to solve.
- Roll-up is ambiguous: it is not clear what a parent's pyramid means when its children disagree.

**Assessment:** the right detail view, the wrong primary view.

### Option 1.2: Treemap or icicle

Every node a rectangle, area by size (lines, or risk), colour by coverage. Click to zoom.

**Pros**

- Whole system visible at once, which is what option 1.1 lacks.
- Area encodes volume honestly, so a large untested package cannot hide next to a small one.
- Scales to far more nodes than the repository will realistically have.

**Cons**

- Collapses seven levels into one colour. It can say a package is under-tested; it cannot say the units are fine and the integration layer is missing, which is precisely the distinction that decides what to write next.
- Area by lines rewards verbosity and misleads on risk.
- Labels are unreliable in small cells, so it needs a second view anyway.

**Assessment:** a good scanning tool for a much larger codebase, but it answers "how much" when the question is "which level".

### Option 1.3: A coverage percentage per node

The conventional approach: instrument, report line or branch coverage, colour a threshold.

**Pros**

- Off-the-shelf. Vitest ships coverage via v8 or istanbul, so this is close to free.
- Produces a trend line, which is the one thing the other options do not.
- Universally understood.

**Cons**

- Satisfiable without asserting anything. A test that imports a module and asserts nothing raises the number.
- Cannot express "not applicable", so type-only and wiring modules read as permanent failures and the report trains people to ignore red.
- Measures execution, not proof, which is the opposite of what testing-strategy §4 says the levels are for.
- Encourages testing what is easy to reach rather than what is consequential.

**Assessment:** reject as the primary signal. Possibly useful later as a secondary trend metric, never as the gate.

### Option 1.4: Tree by level matrix, with the pyramid as the detail view

Rows are nodes in a collapsible tree. Columns are the seven levels. Each cell carries a state rather than a number: **met**, **partial**, **required and absent**, **not yet due**, **not applicable**. Selecting a row shows that node's rolled-up pyramid plus the reasoning behind each cell.

**Pros**

- Scan a column to find systemic gaps (the empty frontend ladder shows up as an empty column).
- Scan a row to find a weak component.
- Rolls up cleanly: a parent shows the worst state any descendant reports, so a collapsed tree is still a true summary.
- Keeps option 1.1 entirely, as the detail panel, so nothing is lost.
- **"Not applicable" is a first-class state.** This is what makes it readable. Without it every leaf shows five red cells and the report is noise. `packages/connector-sdk` is the clearest case: 81 lines of pure interfaces, zero branches, owes nothing at any level, and the honest render is grey rather than red.
- A red cell can be made to always mean "somebody has work to do", which is the property that lets it become a gate later.

**Cons**

- Needs the applicability rule from decision 3 before it can render anything. It is not a drop-in.
- Wide: seven columns plus a node label needs horizontal room, and it degrades on narrow screens.
- The state vocabulary has to be learned, where a percentage does not.
- "Worst descendant wins" roll-up can make a large healthy subtree look bad because of one leaf. Mitigated by showing counts alongside states.

**Assessment:** preferred. A working prototype exists and is loaded with the real repository plus three not-yet-built connector nodes.

### Comparison

| | 1.1 Pyramids | 1.2 Treemap | 1.3 Percentage | 1.4 Matrix |
|---|---|---|---|---|
| Find a gap without clicking | No | Partly | Yes | Yes |
| Distinguish which level is missing | Yes | No | No | Yes |
| Express "not applicable" | Partly | No | No | Yes |
| Roll up to a parent | Ambiguous | Yes | Yes | Yes |
| Usable as a CI gate | No | No | Misleading | Yes |
| Cost to build | Low | Medium | Very low | Medium |

---

## Decision 2: where the nodes come from

### Option 2.1: Author the tree by hand

A checked-in file listing the nodes and their obligations.

**Pros**

- Total control, and can express things no heuristic will infer.
- Zero tooling. Could exist this afternoon.
- Forces an explicit conversation about what the units of the system are.

**Cons**

- Stale within a sprint. A file nobody is forced to update is a file that lies.
- Every new module is a decision and therefore a debate, which is the cost that kills this kind of document.
- Nothing detects a node that has silently disappeared or been renamed.

**Assessment:** reject. This is the failure mode of every hand-maintained architecture diagram.

### Option 2.2: Mirror the filesystem

One node per directory and file.

**Pros**

- Always current, zero maintenance, trivially implemented.
- No ambiguity about what a node is.

**Cons**

- Folder structure is partly incidental, so the tree contains nodes that mean nothing (`src/`, `index.ts` barrels).
- Produces a node for every file whether or not it is a meaningful unit, which floods the report.
- Says nothing about obligations. It gives the rows and leaves all the hard work undone.

**Assessment:** too literal. Useful as the raw input to option 2.3, not as the answer.

### Option 2.3: Derive from artifacts the repo already maintains

Generate nodes from four sources that already exist, are already enforced, and were already agreed for other reasons:

| Source | Produces | Already enforced by |
|---|---|---|
| `pnpm-workspace.yaml` globs | Package nodes (`apps/*`, `packages/*`) | pnpm, and the deploy pipeline |
| Architecture §6.1 layer folders (`domain/`, `db/`, `http/`, `jobs/`, `ai/`, `connectors/`) | Layer nodes inside a service | The one-directional import rule in CI |
| The `Connector` SPI in `packages/connector-sdk` | One node per connector, all with an identical obligation set | The SDK-only import rule for connector packages |
| `commandSchemas` in `packages/shared/src/commands.ts` | The capability axis for F3 | The type system: a command cannot exist outside it |

**Pros**

- Nothing to maintain. Nodes appear and disappear as the code does.
- The layer a file sits in already predicts its level, because `domain/` is pure by the §6.1 import rule. The taxonomy is doing real work rather than being restated.
- The connector case, the one that prompted this document, falls out for free: a new package under `packages/connectors/` appears with its three obligations pre-filled, because architecture §6.2 already specifies them for any connector.
- **The alignment mechanism becomes the rule rather than the tree.** The team agrees once on these four sources; every node after that is assigned rather than argued about.
- A proposed node that cannot be traced to one of the sources is rejected on that ground alone, which keeps the tree from accreting.

**Cons**

- Four sources means four small parsers, and the layer-folder source is a convention that CI enforces but the language does not.
- A node genuinely worth tracking that fits none of the four sources has no home until a fifth source is agreed.
- Couples the report to structural decisions, so a large refactor moves many rows at once.

**Assessment:** preferred.

### Option 2.4: Derive from the test files

Invert it: let the existing tests define the tree, one node per test file or suite.

**Pros**

- Perfectly accurate about what is tested.
- No obligation model needed at all.

**Cons**

- Structurally incapable of showing a gap. A component with no tests produces no node, so the one thing the report exists for is the one thing it cannot show.

**Assessment:** reject. Listed because it is the shape most existing coverage tooling actually has.

---

## Decision 3: when a node owes its own tests

This is the decision that determines whether a cell is red or grey, so it carries most of the report's credibility.

### Option 3.1: Reviewer judgment

The status quo. Testing strategy §10 asks review to reject tests at the wrong level.

**Pros**

- No tooling, infinite flexibility, and a human can see things a rule cannot.
- Already the stated policy, so nothing changes.

**Cons**

- Not visible in a report. Judgment cannot be rendered.
- Inconsistent between reviewers and over time.
- §10 itself says to prefer making violations impossible over catching them in review, so this option is the one that document is trying to move away from.

### Option 3.2: A coverage threshold per node kind

"Domain modules need 90%, adapters 60%."

**Pros**

- Mechanical and familiar.
- Differentiates by node kind, which is better than one global number.

**Cons**

- Inherits every defect of option 1.3, plus the arbitrariness of the thresholds.
- Says nothing about *level*, only about quantity.

### Option 3.3: A three-signal rule

Three inputs, all computable from the AST and the import graph:

1. **Does it decide anything?** Branch count. A module with no conditionals has nothing a unit test could discover: type declarations, re-exports, config objects, plain mappings. This is the signal that produces grey instead of red, and it is what stops the report from crying wolf.
2. **Can it be called with plain data?** Purity, from the import graph: does it reach a database client, `fetch`, a timer, `EventSource`, the filesystem. Pure plus branches means L1. Impure plus branches means the behaviour belongs at L2, or the pure core should be extracted, which testing-strategy §2 asks for anyway.
3. **What breaks if it is wrong?** Fan-in, times a consequence tier (corrupts data, loses data, shows the wrong thing, looks wrong). The only human input, set once per layer rather than per file. It separates *obligated* from merely *eligible*.

Verdict lattice:

| Signals | Verdict |
|---|---|
| Pure, has branches, high blast radius | L1 required |
| Pure, has branches, low blast radius | L1 eligible |
| Impure, has branches, pure core extractable | Refactor, then L1 |
| Impure, has branches, genuinely infrastructural | L2 required |
| No branches, at any purity | No obligation at any level |

**Pros**

- Computable, so it is consistent and it can drive the render.
- Produces the "not applicable" state honestly rather than by fiat.
- It generates refactor recommendations as a side effect, which is behaviour testing-strategy §2 already wants.
- **It reproduces the hand audit.** Run over the current repository it independently arrives at every finding from the manual pass: `http/command-service.ts` as the highest-value gap, `packages/connector-sdk` as correctly untested, `db/repo.ts` as an integration gap rather than a unit gap, and `web/api/queries.ts` as a refactor signal rather than a plain miss. That is the only real evidence the rule is not arbitrary.

**Cons**

- Branch counting is a proxy for complexity and it is a crude one. A branchless module can still be wrong: `packages/shared/ids.ts` is straight-line bit manipulation with zero branches and is obviously worth testing. Implementing the rule confirmed this, and the fix was to let measurement outrank the model, so a module with tests is always reported even where the rule obligates nothing.
- **It cannot express structural obligations at all.** "The Drizzle schema should agree with the migrations" is not a statement about branches, purity or fan-in, so it can only ever be an annotation. Any obligation that is about agreement between two artifacts rather than about behaviour falls outside these three signals.
- Purity detection by import graph has false negatives: a module can be impure through a parameter rather than an import.
- The consequence tier is still a human judgment, just a cheaper one. It can be gamed.
- Three signals is more machinery than a threshold, and it needs the TypeScript compiler API.

**Assessment:** preferred, with the caveat under "risks" below.

### Option 3.4: Mutation testing

Measure adequacy by mutating the source and checking whether tests fail.

**Pros**

- The only option here that measures whether tests actually *assert* anything.
- Immune to the coverage-without-assertions defect.

**Cons**

- Expensive, in minutes per run, which collides with the testing-strategy §7 budget.
- Says nothing about missing levels, only about the quality of tests that already exist.
- Only meaningful where tests exist, so it cannot find a gap.

**Assessment:** complementary rather than competing. Worth revisiting once several levels are populated, as a quality check on the tests the matrix says are present.

---

## Decision 4: how the report is consumed

| Option | Pros | Cons |
|---|---|---|
| **Regenerate on demand**, a command someone runs | Cheapest. No infrastructure. | A report nobody is required to read gets read once. |
| **Published page**, regenerated per build | Shareable, linkable, good for a review conversation. | Still advisory. Drifts if the build stops publishing it. |
| **CI gate on new red cells** | The only version that changes behaviour. Fails on a new unmet obligation rather than on a percentage dropping, which is a defensible thing to block a merge on. | Creates the incentive described under risks. Needs the applicability rule to be trustworthy first. |

Suggested order: build the generator, publish the page, live with it for a few weeks to see whether the applicability calls hold up, then gate.

---

## Cost to build

| Piece | Approach | Rough size |
|---|---|---|
| Nodes | Read `pnpm-workspace.yaml`, walk `src/`, map layer folders to node kinds | Half a day |
| Signals | One pass with the TypeScript compiler API gives branch counts and the import graph, so purity and fan-in fall out together | One to two days |
| Actuals | Vitest already reports which test file exercised which module. Map test file to node and count. No instrumentation needed | Half a day |
| Obligations | A table of node kind to required levels, transcribed from testing-strategy | About thirty lines, reviewed by a human |
| Render | The matrix plus detail panel | One day |

The obligations table is the only piece that encodes policy. It should stay small enough to read in one sitting.

---

## Risks

- **Gaming applicability.** The moment this is a gate, the cheapest way to a green build is to argue a node into "not applicable" rather than test it. Mitigation: keep applicability derived from the three signals and reviewable in the diff, so downgrading a node is a visible code change rather than a dashboard setting.
- **Proxy drift.** Branch count and fan-in are proxies for "worth testing". They will be wrong at the margin. The report should show the signals alongside the verdict so a wrong call is arguable with evidence.
- **A second true source of nodes.** If a meaningful unit appears that none of the four sources produces, the temptation is to hand-add it, which reopens option 2.1. Better to add a fifth derivation source deliberately.
- **The report becoming the goal.** Every one of these options measures obligations, not correctness. A fully green matrix means every level that should have a test has one, not that the software works. Testing-strategy §6.2 (start the application and exercise the change) remains the thing none of this replaces.

---

## Current state, for reference

Measured on `a0ad763`, all assets run and passing:

- 3 test assets: 10 Vitest tests (15 assertions) and 43 bash assertions.
- 1 of 6 levels populated (L1). L2, L3, F1, F2, F3 and the contract suite are empty.
- 215 of 1,526 source lines (14%) live in a file with any test. No coverage tooling is configured.
- 7 capabilities in the command registry, 0 end-to-end tests, which is a standing violation of testing-strategy §5.1.
- Highest-value gap: `apps/api/src/http/command-service.ts`, the single write path, holding idempotency, batch atomicity and the stale-command branch.

## Prototype

[poc/coverage-explorer](../poc/coverage-explorer/README.md) implements the preferred options above: 1.4 (tree by level matrix), 2.3 (derive nodes from existing artifacts) and 3.3 (the three-signal rule). It generates the model from the repository rather than from a hand-written fixture, so it stays current as the code moves.

```bash
cd poc/coverage-explorer && npm install && npm run build   # writes out/index.html
```

It sits outside the pnpm workspace, so it never runs in CI and cannot break the build. The analysis and the rendering are separated by a model contract, precisely because decision 1 is the least settled: swapping the matrix for a treemap is a new file under `src/render/`, and `--json` emits the model for any other consumer.

Two findings came out of implementing it that were not visible from the discussion alone, and both are now recorded in the cons above:

- **The branch signal misses branchless-but-worth-testing modules.** `packages/shared/ids.ts` is straight-line bit manipulation with zero branches, and the rule alone obligates nothing there. The tool handles it by always reporting tests that exist, but the rule needed the patch.
- **The rule cannot express structural obligations at all.** "The Drizzle schema should agree with the migrations" is not a statement about branches, purity or fan-in. It is an annotation, and there will be others.

Two clickable pages were also produced during the discussion, as Claude artifacts. They are private to the author unless shared and are not part of the build:

- Static audit of the current suite: `https://claude.ai/code/artifact/7c68ea2d-81ce-4801-8f42-ec225b17e927`
- The same explorer, hand-loaded: `https://claude.ai/code/artifact/50d03585-fc91-423f-a9cd-67e24576ed48`
