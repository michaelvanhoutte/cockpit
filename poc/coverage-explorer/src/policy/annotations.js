/**
 * HUMAN OVERRIDES.
 *
 * Every entry here is a place the three-signal rule gets the wrong answer and a
 * person overrode it. They are kept in one small file, separate from the rule
 * itself, for two reasons:
 *
 *  1. The rendered report marks annotated cells differently from derived ones,
 *     so a judgment call is never mistaken for a measurement.
 *  2. Overriding a node is then a visible diff in code review rather than a
 *     setting someone changed in a dashboard. That matters most if this ever
 *     becomes a CI gate, because the cheapest route to a green build is to
 *     argue a node into "not applicable" instead of testing it.
 *
 * A growing list here is a signal that the rule needs fixing, not that more
 * annotations are needed. Each entry states the reason in full.
 */

/**
 * Keyed by repo-relative path, then by level.
 * `state` overrides the computed state outright; `why` replaces the reasoning.
 */
export const CELL_ANNOTATIONS = {
  'apps/api/src/db/schema.ts': {
    L2: {
      state: 'gap',
      why:
        'The rule sees zero branches and concludes no obligation, which is wrong here. Schema-to-migration ' +
        'agreement is a structural obligation rather than a behavioural one, and the three signals do not model ' +
        'it. Nothing asserts that these Drizzle models match apps/api/migrations, and drift surfaces first in a ' +
        'deployed environment.',
    },
  },
  'apps/web/src/api/queries.ts': {
    F1: {
      state: 'thin',
      why:
        'The rule finds no branches and so obligates nothing. That is technically true and practically wrong: ' +
        'the invalidation decision inside useCommand is real logic, it is pure, and it is sealed inside a hook ' +
        'that owns a query client. Extract it and it becomes a clean F1 node. Recorded as a refactor signal ' +
        'rather than a plain gap.',
    },
  },
  'apps/api/src/ai/index.ts': {
    C: {
      state: 'later',
      why:
        'Architecture §6.4 puts the model provider behind recorded fixtures with a scheduled contract test for ' +
        'deprecations and response-shape drift. Not derivable, because the current implementation is a no-op ' +
        'that calls nothing. Due with the first real model call.',
    },
  },
  'scripts/health-check.sh': {
    L1: {
      state: 'thin',
      why:
        'It is itself an assertion rather than a tested unit, so the rule has nothing to say about it. Its four ' +
        'failure branches (redirect, unreachable, wrong status, 200 with the wrong body) have no self-test. Low ' +
        'priority, but not zero.',
    },
  },
};

/**
 * Nodes that are not TypeScript and so cannot be derived by the analyzer, plus
 * nodes that do not exist yet but whose obligations are already specified.
 *
 * The connector entries are the case that motivated the whole exercise: their
 * obligations come from architecture §6.2, not from any code, so they can be
 * listed before a single line is written. When packages/connectors/slack really
 * exists, the analyzer picks it up from the workspace glob and its entry here
 * should be deleted.
 */
export const EXTRA_NODES = [
  {
    parent: 'root',
    id: 'connectors-pkg',
    name: 'packages/connectors/',
    path: 'packages/connectors',
    kind: 'pkg',
    projected: true,
    note:
      'Not built yet. Each connector is its own node with its own full pyramid, and the obligations are already ' +
      'specified by architecture §6.2, identically for all of them, because they all implement the same SPI.',
    children: ['slack', 'notion', 'gmail'].map((id) => ({
      id: `connector-${id}`,
      name: id,
      path: `packages/connectors/${id}`,
      kind: 'connector',
      projected: true,
      note:
        id === 'slack'
          ? 'The POC established the quirks that become its L1 cases: full-list-and-diff for saved messages, ' +
            'high-water mark for DMs and mentions, <@U123|Name> markup, bot and self filtering.'
          : 'Same obligation set as every other connector, because the SPI is the same. That is the property ' +
            'that makes this scale: a new connector never needs a decision about what to test.',
    })),
  },
  {
    parent: 'root',
    id: 'scripts',
    name: 'scripts/',
    path: 'scripts',
    kind: 'tooling',
    note:
      'Deploy tooling, outside the six-level taxonomy. It gets a home in the tree anyway, because work that is ' +
      'real but unclassified is work that goes unwatched.',
    children: [
      {
        id: 'branch-alias',
        name: 'branch-alias.sh',
        path: 'scripts/branch-alias.sh',
        kind: 'module',
        note: 'Derives every branch preview URL.',
        // Hand-declared: there is no bash AST here, so the analyzer cannot count
        // these. Verified by running scripts/branch-alias.test.sh.
        own: {
          L1: {
            state: 'ok',
            count: 43,
            why:
              '43 assertions in plain bash: four pinned aliases, three invariants over twelve branch shapes, and ' +
              'three collision pairs including names identical past the truncation point. Counted by hand, not ' +
              'derived, because the analyzer only reads TypeScript.',
          },
        },
      },
      {
        id: 'health-check',
        name: 'health-check.sh',
        path: 'scripts/health-check.sh',
        kind: 'module',
        note: 'The only assertion in the repo that runs against real deployed code.',
        own: { L1: { state: 'thin', count: 0 } },
      },
    ],
  },
];

/** Free-text notes shown in the detail panel, keyed by repo-relative path. */
export const NODE_NOTES = {
  'apps/api': 'The Worker. It owns D1, the queues and the cron triggers, so it is the node that owns the integration level.',
  'apps/web': 'React and Vite PWA. No test runner is installed in this package at all, so the entire frontend ladder is empty.',
  'packages/shared': 'The contract package: domain types, Zod schemas, command definitions. Pure throughout, so it is unit territory end to end.',
  'packages/connector-sdk': 'The two-sided SPI. Pure interfaces and type aliases, zero branches, nothing to execute. Typecheck is the complete and correct verification.',
  'apps/api/src/domain': 'Pure by the §6.1 import rule, which is what makes the unit tier a property of the design rather than a mocking exercise.',
  'apps/api/src/db': 'Impure by definition. Nothing here is a unit-test node; the whole layer belongs to the integration level.',
  'apps/api/src/http': 'Thin adapters by intent, except command-service.ts, which is where the write path actually lives.',
  'apps/api/src/http/command-service.ts': 'The single write path: idempotency check, pure handler, then data change and command-log entry in one D1 batch.',
  'apps/api/src/db/repo.ts': 'Six query functions, every one applying tenant scoping.',
  'apps/web/src/api': 'The client edge. Impure by nature, which is why these are service-frontend nodes rather than frontend-unit ones.',
  'apps/web/src/components/ItemRow.tsx': 'The densest branching in the frontend: status, priority and source rendering.',
  'packages/shared/src/commands.ts': 'The command registry: one schema per capability. Also the source of the capability axis.',
};
