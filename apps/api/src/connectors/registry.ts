import type { Connector } from '@cockpit/connector-sdk';

/**
 * The composition root (architecture §6.2): the application knows connectors
 * ONLY as this list. One line per connector, nothing else couples the core to
 * a source. Promotion to dynamic loading later is a change to this file only.
 */
export const connectors: Connector[] = [
  // gmailConnector, slackConnector, notionConnector — each lands as its own
  // packages/connectors/* package importing only @cockpit/connector-sdk.
];

export function getConnector(id: string): Connector | undefined {
  return connectors.find((c) => c.manifest.id === id);
}
