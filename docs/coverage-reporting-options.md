# Test Coverage Reporting Options

**Status:** options document, no decision committed. Written from the audit of commit `a0ad763`. Superseded on decisions 1.4 and 2.3 by [test-explorer-spec.md](test-explorer-spec.md), which is what got built; this stays as the record of the options considered.

## Goal

Answer, without reading the code, two questions about any part of Cockpit: which test levels it **owes** and which it **has**, and which parts owe something they do not have.

The audit that prompted this produced a single pyramid for the whole repository. That showed the shape of today's suite — one populated level out of six — but it does not survive the next phase: once `packages/connectors/*` exists, every connector is its own testable unit with its own unit tests, fixtures and scheduled contract test, and a single pyramid averages all of that into one picture.

So the question is three decisions, taken in order: what shape the report takes, where its nodes come from, and how we decide a node owes tests at a given level. [testing-strategy.md](testing-strategy.md) defines the levels and obligations; this is only about making them visible.

## Finding that constrains all three decisions

The levels do not all attach at the same height of a structural tree:

| Level | Attaches to |
|---|---|
| L1 unit, F1 frontend unit | Leaves: individual modules and components |
| L2 integration, F2 service-frontend | Whatever owns infrastructure: a deployable service |
| Contract | Boundaries: one per third-party integration |
| L3 system | The composition of services, near the root |
| F3 end-to-end | **Capabilities**, which cut across the tree entirely |

The last row is the awkward one: "a user can snooze an item" touches a component, a hook, a route, a handler and a table, and belongs to no node. Any option below has to carry a second, capability-indexed axis alongside the structural one, or it silently drops the mandatory-coverage rule. Cockpit already has that list machine-readable in `commandSchemas`.

## Decision 1: the shape of the report

**1.1 Drill-down pyramids.** One pyramid per node, click to descend.
*Pros:* keeps the mental model the audit established at zero re-learning cost; genuinely the best shape for reading a single component, since it puts levels in cost order and makes an inverted suite obvious.
*Cons:* no overview, so finding the worst node means visiting every node — the "read the code" problem restated; roll-up is ambiguous when children disagree.
*Assessment:* the right detail view, the wrong primary view.

**1.2 Treemap or icicle.** Area by size, colour by coverage.
*Pros:* whole system visible at once; area encodes volume honestly, so a large untested package cannot hide beside a small one.
*Cons:* collapses seven levels into one colour, so it cannot say the units are fine and the integration layer is missing — precisely the distinction that decides what to write next. Area by lines rewards verbosity, and small-cell labels are unreliable.
*Assessment:* a good scanning tool for a much larger codebase; it answers "how much" when the question is "which level".

**1.3 A coverage percentage per node.**
*Pros:* off-the-shelf, produces a trend line, universally understood.
*Cons:* satisfiable without asserting anything; cannot express "not applicable", so type-only and wiring modules read as permanent failures and the report trains people to ignore red; measures execution rather than proof; rewards testing what is easy to reach.
*Assessment:* reject as the primary signal. Possibly a secondary trend metric later, never the gate.

**1.4 Tree-by-level matrix, with the pyramid as the detail view.** Rows are nodes in a collapsible tree, columns the seven levels, each cell a state — met, partial, required-and-absent, not yet due, not applicable.
*Pros:* scan a column for systemic gaps and a row for a weak component; rolls up cleanly, a parent showing the worst state any descendant reports; keeps 1.1 entirely as the detail panel. **"Not applicable" is a first-class state**, which is what makes it readable — `packages/connector-sdk` is 81 lines of pure interfaces with zero branches, and the honest render is grey rather than red. A red cell can then always mean somebody has work to do, which is what lets it become a gate.
*Cons:* needs decision 3's applicability rule before it can render anything; seven columns need horizontal room; the state vocabulary has to be learned; "worst descendant wins" can make a large healthy subtree look bad, mitigated by showing counts alongside states.
*Assessment:* preferred.

| | 1.1 Pyramids | 1.2 Treemap | 1.3 Percentage | 1.4 Matrix |
|---|---|---|---|---|
| Find a gap without clicking | No | Partly | Yes | Yes |
| Distinguish which level is missing | Yes | No | No | Yes |
| Express "not applicable" | Partly | No | No | Yes |
| Roll up to a parent | Ambiguous | Yes | Yes | Yes |
| Usable as a CI gate | No | No | Misleading | Yes |
| Cost to build | Low | Medium | Very low | Medium |

## Decision 2: where the nodes come from

**2.1 Author the tree by hand.**
*Pros:* total control, zero tooling, and it forces an explicit conversation about what the units are.
*Cons:* stale within a sprint, because a file nobody is forced to update is a file that lies; every new module becomes a debate; nothing detects a node that disappeared or was renamed.
*Assessment:* reject — the failure mode of every hand-maintained architecture diagram.

**2.2 Mirror the filesystem.**
*Pros:* always current, zero maintenance, no ambiguity about what a node is.
*Cons:* folder structure is partly incidental, so the tree fills with meaningless nodes; a node per file floods the report; it says nothing about obligations.
*Assessment:* too literal — the raw input to 2.3, not the answer.

**2.3 Derive from artifacts the repo already maintains.**

| Source | Produces | Already enforced by |
|---|---|---|
| `pnpm-workspace.yaml` globs | Package nodes | pnpm, and the deploy pipeline |
| Architecture's layer folders (`domain/`, `db/`, `http/`, `jobs/`, `ai/`, `connectors/`) | Layer nodes inside a service | The one-directional import rule in CI |
| The `Connector` SPI in `packages/connector-sdk` | One node per connector, identical obligations | The SDK-only import rule |
| `commandSchemas` in `packages/shared` | The capability axis for F3 | The type system |

*Pros:* nothing to maintain, since nodes appear and disappear as the code does; the layer a file sits in already predicts its level, because `domain/` is pure by the import rule; the connector case that prompted this document falls out for free. **The alignment mechanism becomes the rule rather than the tree** — agree once on the four sources and every node after that is assigned rather than argued about, and a proposed node traceable to none of them is rejected on that ground.
*Cons:* four sources means four small parsers, and the layer-folder source is a convention CI enforces but the language does not; a node worth tracking that fits none of them has no home until a fifth is agreed; a large refactor moves many rows at once.
*Assessment:* preferred.

**2.4 Derive from the test files.**
*Pros:* perfectly accurate about what is tested, and no obligation model needed.
*Cons:* structurally incapable of showing a gap — a component with no tests produces no node.
*Assessment:* reject. Listed because it is the shape most existing coverage tooling actually has.

## Decision 3: when a node owes its own tests

This determines whether a cell is red or grey, so it carries most of the report's credibility.

**3.1 Reviewer judgment** (the status quo).
*Pros:* no tooling, infinite flexibility, already the stated policy.
*Cons:* judgment cannot be rendered, is inconsistent between reviewers, and the testing strategy itself says to prefer making violations impossible over catching them in review.

**3.2 A coverage threshold per node kind.**
*Pros:* mechanical, familiar, and differentiating by kind beats one global number.
*Cons:* inherits every defect of 1.3 plus arbitrary thresholds, and says nothing about *level*.

**3.3 A three-signal rule.** All computable from the AST and import graph:

1. **Does it decide anything?** Branch count. A module with no conditionals has nothing a unit test could discover, which is the signal that produces grey instead of red.
2. **Can it be called with plain data?** Purity from the import graph — does it reach a database client, `fetch`, a timer, the filesystem. Pure plus branches means L1; impure plus branches means L2 or an extractable pure core.
3. **What breaks if it is wrong?** Fan-in times a consequence tier, the only human input, set once per layer. It separates *obligated* from merely *eligible*.

| Signals | Verdict |
|---|---|
| Pure, has branches, high blast radius | L1 required |
| Pure, has branches, low blast radius | L1 eligible |
| Impure, has branches, pure core extractable | Refactor, then L1 |
| Impure, has branches, genuinely infrastructural | L2 required |
| No branches, at any purity | No obligation at any level |

*Pros:* computable, so it is consistent and can drive the render; produces "not applicable" honestly rather than by fiat; generates refactor recommendations as a side effect. **It reproduces the hand audit**, independently arriving at every finding of the manual pass — `command-service.ts` as the highest-value gap, `connector-sdk` as correctly untested, `db/repo.ts` as an integration rather than a unit gap, `web/api/queries.ts` as a refactor signal. That is the only real evidence the rule is not arbitrary.
*Cons:* branch counting is a crude proxy — `packages/shared/ids.ts` is straight-line bit manipulation with zero branches and obviously worth testing, so the rule was patched to let measurement outrank the model. **It cannot express structural obligations at all**: "the Drizzle schema should agree with the migrations" is not a statement about branches, purity or fan-in, so any obligation about agreement between two artifacts falls outside these signals and can only be an annotation. Purity detection has false negatives through parameters, the consequence tier is still human judgment, and it needs the TypeScript compiler API.
*Assessment:* preferred, with the caveat under Risks.

**3.4 Mutation testing.**
*Pros:* the only option that measures whether tests actually *assert* anything.
*Cons:* expensive in minutes per run, says nothing about missing levels, and is only meaningful where tests exist, so it cannot find a gap.
*Assessment:* complementary rather than competing; revisit once several levels are populated.

## Decision 4: how the report is consumed

| Option | Pros | Cons |
|---|---|---|
| **Regenerate on demand** | Cheapest, no infrastructure | A report nobody must read gets read once |
| **Published page** per build | Shareable, linkable, good for a review conversation | Still advisory; drifts if the build stops publishing it |
| **CI gate on new red cells** | The only version that changes behaviour, and failing on a new unmet obligation is a defensible thing to block a merge on | Creates the gaming incentive under Risks; needs the applicability rule to be trustworthy first |

Suggested order: build the generator, publish the page, live with it for a few weeks to see whether the applicability calls hold up, then gate.

## Cost to build

| Piece | Approach | Rough size |
|---|---|---|
| Nodes | Read `pnpm-workspace.yaml`, walk `src/`, map layer folders to node kinds | Half a day |
| Signals | One TypeScript compiler API pass gives branch counts and the import graph, so purity and fan-in fall out together | One to two days |
| Actuals | Map test file to node and count; no instrumentation needed | Half a day |
| Obligations | A table of node kind to required levels, transcribed from testing-strategy | ~30 lines, human-reviewed |
| Render | The matrix plus detail panel | One day |

The obligations table is the only piece encoding policy, and should stay small enough to read in one sitting.

## Risks

- **Gaming applicability.** Once this is a gate, the cheapest way to green is arguing a node into "not applicable". Mitigation: keep applicability derived from the three signals and reviewable in the diff, so a downgrade is a visible code change rather than a dashboard setting.
- **Proxy drift.** Branch count and fan-in will be wrong at the margin, so the report should show the signals alongside the verdict, making a wrong call arguable with evidence.
- **A second true source of nodes.** If a meaningful unit appears that none of the four sources produces, hand-adding it reopens option 2.1. Add a fifth derivation source deliberately instead.
- **The report becoming the goal.** Every option here measures obligations, not correctness. A fully green matrix means every level that should have a test has one, not that the software works.

## Current state, for reference

Measured on `a0ad763`, all assets run and passing:

- 3 test assets: 10 Vitest tests (15 assertions) and 43 bash assertions.
- 1 of 6 levels populated (L1); L2, L3, F1, F2, F3 and contract are empty.
- 215 of 1,526 source lines (14%) live in a file with any test. No coverage tooling configured.
- 7 capabilities in the command registry, 0 end-to-end tests — a standing violation of the mandatory-coverage rule.
- Highest-value gap: `apps/api/src/http/command-service.ts`, the single write path, holding idempotency, batch atomicity and the stale-command branch.

## Prototype

[poc/coverage-explorer](../poc/coverage-explorer/README.md) implements 1.4, 2.3 and 3.3, generating the model from the repository rather than a fixture.

```bash
cd poc/coverage-explorer && npm install && npm run build   # writes out/index.html
```

It sits outside the pnpm workspace, so it never runs in CI. Analysis and rendering are separated by a model contract precisely because decision 1 is the least settled: swapping the matrix for a treemap is a new file under `src/render/`, and `--json` emits the model for any other consumer.

Two findings came out of implementing it that the discussion alone did not surface, both now recorded in the cons above: the branch signal misses branchless-but-worth-testing modules, and the rule cannot express structural obligations at all.

Two clickable pages were also produced during the discussion as Claude artifacts, private to the author and not part of the build: a static audit of the suite (`https://claude.ai/code/artifact/7c68ea2d-81ce-4801-8f42-ec225b17e927`) and the same explorer hand-loaded (`https://claude.ai/code/artifact/50d03585-fc91-423f-a9cd-67e24576ed48`).
