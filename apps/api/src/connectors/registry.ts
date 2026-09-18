import type { Connector } from '@cockpit/connector-sdk';
import { createTeamsConnector } from '@cockpit/connector-teams';
import type { Env } from '../env.js';

/**
 * The composition root (architecture §6.2): the application knows connectors
 * ONLY as this list. One line per connector, nothing else couples the core to
 * a source. Promotion to dynamic loading later is a change to this file only.
 *
 * **A function of the environment rather than a constant**, since "Save a Teams
 * message to Cockpit" (issue 486): what a connector needs to know about itself
 * is a secret per environment, and a connector that has not been told it is one
 * this environment does not have. So an environment with no `MS_BOT_APP_ID`
 * offers no Teams ingress at all rather than one that refuses everything, which
 * is the same standing every other absent secret has (`src/env.ts`).
 */
export function connectors(env: Env): Connector[] {
  return [
    // gmailConnector, slackConnector, notionConnector - each lands as its own
    // packages/connectors/* package importing only @cockpit/connector-sdk.
    ...(env.MS_BOT_APP_ID ? [createTeamsConnector({ appId: env.MS_BOT_APP_ID })] : []),
  ];
}

export function getConnector(env: Env, id: string): Connector | undefined {
  return connectors(env).find((c) => c.manifest.id === id);
}
