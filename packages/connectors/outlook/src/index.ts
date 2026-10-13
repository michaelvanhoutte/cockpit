import type { Connector } from '@cockpit/connector-sdk';
import type { OutlookConnectorConfig } from './graph.js';
import { outlookAccountFrom, outlookSignIn } from './sign-in.js';
import { syncMailbox } from './sync.js';

/**
 * The Outlook connector: messages flagged for follow-up, or carrying the
 * category Cockpit, arrive as Tasks in a Microsoft 365 mailbox's Workspace
 * ("Build Outlook as a connector package on the SDK, unregistered", issue
 * 1046). It only reads the mailbox: writing the mark back as Items close is a
 * later slice, and nothing offers this connector until it is registered.
 *
 * Everything this package knows about Outlook and Microsoft Graph is in its README.
 */

/** Who this connector is, needing no configuration. */
export const OUTLOOK_IDENTITY = { id: 'outlook', displayName: 'Outlook' } as const;

export function createOutlookConnector(config: OutlookConnectorConfig): Connector {
  return {
    manifest: {
      ...OUTLOOK_IDENTITY,
      cardText:
        'Sign in with your Microsoft 365 work or school account. Messages you flag, or categorise Cockpit, become tasks.',
      supportsPush: false,
      pulled: true,
      arrivesAs: 'task',
      // The flag is offered to start. Unlike a Gmail label, a mailbox needs no
      // category called Cockpit in its list: Outlook accepts the name on a
      // message either way.
      choice: {
        question: 'Bring in messages',
        options: [
          { value: 'flag', label: 'Flagged' },
          { value: 'category', label: 'Category Cockpit' },
        ],
      },
      auth: outlookSignIn(config.issuer),
    },

    accountFrom: outlookAccountFrom,

    sync: (host) => syncMailbox(host, config),

    // No `revoke`: Microsoft offers no revoke of one application's grant, and
    // the only call that ends a person's tokens signs them out everywhere.
  };
}

export { MAIL_READ_WRITE, OUTLOOK_REFUSALS } from './sign-in.js';
export type { OutlookConnectorConfig } from './graph.js';
