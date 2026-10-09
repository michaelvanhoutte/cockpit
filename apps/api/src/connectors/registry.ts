import type { Connector } from '@cockpit/connector-sdk';
import { GMAIL_IDENTITY, createGmailConnector } from '@cockpit/connector-gmail';
import { TEAMS_IDENTITY, createTeamsConnector } from '@cockpit/connector-teams';
import type { Env } from '../env.js';
import { NAMED_SOURCES } from '../domain/named-sources.js';

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
 * is the same standing every other absent secret has (`src/env.ts`). **And no
 * way to connect one**: the sign-in routes find a connector here, so a source
 * that is not registered is not found there either ("Connect and disconnect a
 * source through one generic sign-in flow", issue 892).
 */
export function connectors(env: Env): Connector[] {
  const gmailIssuer = standIn(env.OIDC_ISSUER);
  const gmailApi = standIn(env.GMAIL_API_ORIGIN);
  return [
    ...(env.GMAIL_CLIENT_ID?.trim() && env.GMAIL_CLIENT_SECRET?.trim()
      ? [
          createGmailConnector({
            clientId: env.GMAIL_CLIENT_ID.trim(),
            clientSecret: env.GMAIL_CLIENT_SECRET.trim(),
            // The stub issuer and its stand-in mailbox locally and in the
            // browser suite; Google's own wherever else (`standIn`).
            ...(gmailIssuer ? { issuer: gmailIssuer } : {}),
            ...(gmailApi ? { apiOrigin: gmailApi } : {}),
          }),
        ]
      : []),
    ...(env.MS_BOT_APP_ID
      ? [
          createTeamsConnector({
            appId: env.MS_BOT_APP_ID,
            // The stub issuer locally and in the browser suite, Microsoft's own
            // where nothing overrides it (`whoToBelieve`, auth/issuer.ts).
            ...(env.OIDC_ISSUER?.trim() ? { issuer: env.OIDC_ISSUER.trim() } : {}),
            ...(env.BOT_FRAMEWORK_METADATA_URL
              ? { metadataUrl: env.BOT_FRAMEWORK_METADATA_URL }
              : {}),
          }),
        ]
      : []),
    // Set by the backend suite alone (`src/env.ts`).
    ...(env.TEST_CONNECTORS ?? []),
  ];
}

/**
 * An address a local stack points a connector at in place of the source's own,
 * believed only where it is one: a loopback host or a name under `.localhost`
 * or `.test`, which nothing deployed can be reached at. **Gmail's issuer and
 * API origin are read through this** because a deployment that set either
 * would send its mailbox tokens wherever it pointed; so a value set in
 * deployed configuration by mistake is ignored rather than obeyed, and Google's
 * own is used.
 */
export function standIn(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || !URL.canParse(trimmed)) return null;
  const host = new URL(trimmed).hostname.toLowerCase();
  const local =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host.endsWith('.localhost') ||
    host.endsWith('.test');
  return local ? trimmed : null;
}

/**
 * Every connector package Cockpit carries, by who it is, whether or not this
 * environment configures it: an Item it made keeps its name where it can no
 * longer connect or push. One line per package, beside its line above.
 */
const KNOWN_CONNECTORS: readonly { readonly id: string; readonly displayName: string }[] = [
  GMAIL_IDENTITY,
  TEAMS_IDENTITY,
];

/**
 * What each source is called on screen, by connector id ("Take source names
 * out of the shared contract", issue 927): every connector package by its own
 * name, configured here or not, every registered connector by its manifest's,
 * and the sources the core still names itself (`domain/named-sources.ts`),
 * which win over a connector of the same id. An id nothing names is absent,
 * and so reads as itself.
 */
export function sourceNames(env: Env): Record<string, string> {
  return {
    ...Object.fromEntries(KNOWN_CONNECTORS.map(({ id, displayName }) => [id, displayName])),
    ...Object.fromEntries(connectors(env).map(({ manifest }) => [manifest.id, manifest.displayName])),
    ...NAMED_SOURCES,
  };
}

export function getConnector(env: Env, id: string): Connector | undefined {
  return connectors(env).find((c) => c.manifest.id === id);
}

/** The connectors Cockpit pulls from, whose connections the account's store keeps a check armed for. */
export function pulledConnectorIds(env: Env): string[] {
  return connectors(env)
    .filter((c) => c.manifest.pulled === true)
    .map((c) => c.manifest.id);
}

/** The pulled connectors that mirror an Item's open state back to their source - declared and able to, since a change recorded for one that cannot is never confirmed (issue 893). */
export function mirroringConnectorIds(env: Env): string[] {
  return connectors(env)
    .filter((c) => c.manifest.pulled === true && c.manifest.mirrorsOpenState === true && typeof c.mirrorOpenState === 'function')
    .map((c) => c.manifest.id);
}
