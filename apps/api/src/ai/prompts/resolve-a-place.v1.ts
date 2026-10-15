import { panelTakesItems } from '@cockpit/shared';
import type { PlaceTreeWorkspace } from '../../domain/spoken-path.js';

/**
 * Every word of the system prompt that is the same for every note and every
 * account, so it can be the first cached prefix (`index.ts`), as
 * `clean-up-a-note.v16`'s is.
 */
const INSTRUCTIONS = `You are part of Cockpit, one person's inbox for their own work.

Somebody captured a note and said where it should go, in a few words typed or dictated in a hurry. You are given those words, and the names of the places this account has: its workspaces, each one's dashboards, and each dashboard's panels. You say which of those names the words mean, and nothing else.

Match each word to a name only where it plainly means that name - "admin and money" means a panel called "Admin & money", "day to day" a dashboard called "Day to day", "for home" a workspace called "Home". Write every name exactly as the list spells it. A word that matches no name is left out; never guess the nearest one, and never give a name the words do not say.

Give the workspace where the words name one, the dashboard where they name one, and every panel they name, in the order said. Leave the workspace and the dashboard empty, and the panels an empty list, wherever the words name none.`;

/**
 * What Cockpit asks Claude for the names a note's place words mean ("File a
 * capture on the panels you name, read from the spoken path", issue 1116).
 * Version 1.
 *
 * **Asked only where the clean-up read place words**, so a capture naming no
 * place costs nothing more and shows no name. It is shown the names of the
 * Workspaces the capture may reach - all of them for one captured to *Any
 * workspace*, its own otherwise - and their Dashboards and the Panels that take
 * items: names only, never an Item.
 *
 * **The schema holds the names it was shown**, so every name in the answer is
 * structurally one of them. Whether those names point to one place is decided
 * by the server (`resolveSpokenPath`), never here.
 */
export function buildResolveAPlace(
  words: string,
  tree: readonly PlaceTreeWorkspace[],
): {
  version: 'v1';
  model: string;
  effort: null;
  system: { instructions: string; stable: string; recent: string };
  message: string;
  schema: Record<string, unknown>;
} {
  const workspaces = distinct(tree.map((workspace) => workspace.name));
  const dashboards = distinct(tree.flatMap((workspace) => workspace.dashboards.map((dashboard) => dashboard.name)));
  const panels = distinct(
    tree.flatMap((workspace) =>
      workspace.dashboards.flatMap((dashboard) =>
        dashboard.panels.filter(panelTakesItems).map((panel) => panel.name),
      ),
    ),
  );
  return {
    version: 'v1',

    /**
     * Haiku 4.5, as `choose-a-panel.v2`: matching a few words to a short list
     * of names is a narrower task than writing a title. No `effort`, which this
     * model refuses.
     */
    model: 'claude-haiku-4-5',
    effort: null,

    system: { instructions: INSTRUCTIONS, stable: renderPlaces(tree), recent: '' },

    message: `Where it should go: ${JSON.stringify(words)}`,

    schema: {
      type: 'object',
      properties: {
        workspace: {
          type: 'string',
          enum: [...workspaces, ''],
          description: 'The workspace the words name, exactly as listed - or the empty string where they name none.',
        },
        dashboard: {
          type: 'string',
          enum: [...dashboards, ''],
          description: 'The dashboard the words name, exactly as listed - or the empty string where they name none.',
        },
        panels: {
          type: 'array',
          items: { type: 'string', enum: panels.length > 0 ? panels : [''] },
          description: 'Every panel the words name, exactly as listed, in the order said - empty where they name none.',
        },
      },
      required: ['workspace', 'dashboard', 'panels'],
      additionalProperties: false,
    },
  };
}

/** The names of the places a capture may reach, nested as the account has them; Panels of text and Filters are left out, since nothing is filed on them. */
export function renderPlaces(tree: readonly PlaceTreeWorkspace[]): string {
  if (tree.length === 0) return 'Places: (this account has none)';
  const lines = tree.flatMap((workspace) => [
    `Workspace: ${workspace.name}`,
    ...workspace.dashboards.flatMap((dashboard) => [
      `  Dashboard: ${dashboard.name}`,
      ...dashboard.panels.filter(panelTakesItems).map((panel) => `    - ${panel.name}`),
    ]),
  ]);
  return `Places:\n${lines.join('\n')}`;
}

function distinct(names: readonly string[]): string[] {
  return [...new Set(names)];
}
