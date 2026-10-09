import type { Connector } from '@cockpit/connector-sdk';
import { credentialIn } from './credential.js';
import { endpointsOf, type GmailConnectorConfig } from './mailbox.js';
import { gmailAccountFrom, gmailSignIn } from './sign-in.js';
import { mirrorOpenStates, syncMailbox } from './sync.js';

/**
 * The Gmail connector: conversations labelled Cockpit, or starred, arrive as
 * Tasks; a label or star taken off closes the Task, and closing or reopening a
 * Task in Cockpit takes the label or star off or puts it back
 * ("Build Gmail as a connector package on the SDK, unregistered", issue 943).
 *
 * **Not registered yet**: the application's registry does not list it, so a
 * running Cockpit is unchanged ("Switch Gmail onto the generic host, and take it
 * out of the core", issue 944). It reads only the generic credential shape the
 * generic sign-in seals, so no stored Gmail credential is read and every
 * connection reconnects.
 *
 * Everything this package knows about Gmail is in its README.
 */

/**
 * Who this connector is, needing no configuration: what an Item it made is
 * called on screen in every environment, whether or not this one can sign in
 * to Gmail.
 */
export const GMAIL_IDENTITY = { id: 'gmail', displayName: 'Gmail' } as const;

export function createGmailConnector(config: GmailConnectorConfig): Connector {
  return {
    manifest: {
      ...GMAIL_IDENTITY,
      cardText:
        'Sign in with Google. Conversations you label Cockpit, or star, become tasks, and the label or star follows the task.',
      source: 'mail',
      supportsPush: false,
      pulled: true,
      arrivesAs: 'task',
      mirrorsOpenState: true,
      // The label is Cockpit's own and so is the default; a star counts only
      // from the moment of connecting, since Gmail never says when it was set.
      choice: {
        question: 'Bring in conversations',
        options: [
          { value: 'label', label: 'Labelled Cockpit' },
          { value: 'star', label: 'Starred (flagged in Outlook)' },
        ],
      },
      auth: gmailSignIn(config.issuer),
    },

    accountFrom: gmailAccountFrom,

    sync: (host) => syncMailbox(host, config),

    mirrorOpenState: (host, wanted) => mirrorOpenStates(host, config, wanted),

    /**
     * Cancels the grant at Google: a token that can change mail should not
     * outlive the connection. Google revokes the whole grant, not one token -
     * which is why the host calls this only when no other Workspace holds the
     * same mailbox. A failure is the host's to log; it never fails the disconnect.
     */
    async revoke(credentials) {
      const held = credentialIn(credentials);
      if (!held) throw new Error('the stored sign-in could not be read to revoke');
      const { revocationEndpoint } = await endpointsOf(config);
      if (!revocationEndpoint) throw new Error('the issuer names nowhere to revoke a sign-in');
      const response = await (config.fetch ?? fetch)(revocationEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: held.refreshToken }),
        signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Google answered ${response.status} to a revoke`);
    },
  };
}

/** How long Google is given to answer a revoke: the disconnect is already done, so waiting longer buys nothing. */
const REVOKE_TIMEOUT_MS = 5_000;

export { GMAIL_MODIFY, GMAIL_REFUSALS } from './sign-in.js';
export { CALLS_PER_RUN } from './mailbox.js';
export type { GmailConnectorConfig } from './mailbox.js';
