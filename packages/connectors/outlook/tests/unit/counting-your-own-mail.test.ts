import { describe, expect, it } from 'vitest';
import { TURN_FIELDS, addressesOfYours, asYours, othersOn, sendFromAddresses, turnPage } from '../../src/messages.js';
import { DELETED_ITEMS_ID, INBOX_ID, MAILBOX, SENT_ITEMS_ID, message, messagesPage, type MessageOptions } from '../graph-payloads.js';

/**
 * L1, pure: which messages of an Outlook conversation are yours, and whether
 * anyone but you is on it ("Outlook capture: a mail you Cc to your Cockpit alias
 * arrives To do…", issue 1760). Each case is a conversation as Graph answers its
 * messages, read as a check reads it. What the host does with the answer is
 * apps/api's (outlook-conversations-on-the-host.test.ts).
 */

const ALIAS = { name: 'Cockpit', address: 'cockpit@conselit.be' };
const CLIENT = { name: 'Client', address: 'client@example.com' };
const FOLDERS = { sentItems: SENT_ITEMS_ID, deletedItems: DELETED_ITEMS_ID };

/** A conversation's messages as a check reads them, against the alias it holds. */
function read(messages: Omit<MessageOptions, 'conversation'>[], alias: string | null) {
  const { turns } = turnPage(
    messagesPage(
      messages.map((one) => message({ ...one, conversation: 'c-1' })),
      undefined,
      TURN_FIELDS.split(','),
    ),
    FOLDERS,
  );
  const yours = addressesOfYours(alias, sendFromAddresses(turns));
  return { turns: asYours(turns, yours), yours };
}

/** Your mail to the client with the alias in Cc: the copy in Sent Items, and the alias's copy delivered to the Inbox. */
const CC_THE_ALIAS: Omit<MessageOptions, 'conversation'>[] = [
  { id: 'sent', folder: SENT_ITEMS_ID, from: MAILBOX, to: [CLIENT], cc: [ALIAS] },
  { id: 'alias-copy', folder: INBOX_ID, from: MAILBOX, to: [CLIENT], cc: [ALIAS] },
];

describe('Capture', () => {
  describe('a message is yours when it sits in Sent Items, or was sent from an address you send from or from your Cockpit alias', () => {
    it.each([
      { situation: 'a message in Sent Items', messages: CC_THE_ALIAS, alias: ALIAS.address, id: 'sent', by: 'you' },
      {
        situation: 'your alias’s copy in the Inbox, sent from an address seen in Sent Items',
        messages: CC_THE_ALIAS,
        alias: null,
        id: 'alias-copy',
        by: 'you',
      },
      {
        situation: 'a message sent from your alias',
        messages: [{ id: 'from-alias', folder: INBOX_ID, from: ALIAS, to: [ALIAS] }],
        alias: ALIAS.address,
        id: 'from-alias',
        by: 'you',
      },
      {
        situation: 'a message from the client',
        messages: [...CC_THE_ALIAS, { id: 'reply', folder: INBOX_ID, from: CLIENT, to: [MAILBOX], cc: [ALIAS] }],
        alias: ALIAS.address,
        id: 'reply',
        by: 'them',
      },
      {
        situation: 'your address as sender with no alias set and nothing of yours in Sent Items, so nothing to learn it from',
        messages: [{ id: 'alias-copy', folder: INBOX_ID, from: MAILBOX, to: [ALIAS] }],
        alias: null,
        id: 'alias-copy',
        by: 'them',
      },
      {
        situation: 'your alias and address written in another letter case',
        messages: [
          { id: 'sent', folder: SENT_ITEMS_ID, from: { name: 'Anna', address: 'Anna@Example.com' }, to: [ALIAS] },
          { id: 'from-alias', folder: INBOX_ID, from: { name: 'Cockpit', address: 'COCKPIT@conselit.be' }, to: [MAILBOX] },
          { id: 'alias-copy', folder: INBOX_ID, from: { name: 'Anna', address: 'ANNA@example.com' }, to: [ALIAS] },
        ],
        alias: 'Cockpit@Conselit.BE',
        id: ['from-alias', 'alias-copy'],
        by: 'you',
      },
    ])('$situation reads as $by', ({ messages, alias, id, by }) => {
      const { turns } = read(messages, alias);
      for (const one of [id].flat()) expect(turns.find((turn) => turn.messageId === one)?.by).toBe(by);
    });
  });

  describe('a conversation has someone else on it when any sender, To or Cc recipient is neither you nor your Cockpit alias', () => {
    it.each([
      {
        situation: 'a mail to your alias alone',
        messages: [
          { id: 'sent', folder: SENT_ITEMS_ID, from: MAILBOX, to: [ALIAS] },
          { id: 'alias-copy', folder: INBOX_ID, from: MAILBOX, to: [ALIAS] },
        ],
        alias: ALIAS.address,
        othersOnIt: false,
      },
      {
        situation: 'a mail to your alias and your own address',
        messages: [
          { id: 'sent', folder: SENT_ITEMS_ID, from: MAILBOX, to: [ALIAS, MAILBOX] },
          { id: 'alias-copy', folder: INBOX_ID, from: MAILBOX, to: [ALIAS, MAILBOX] },
        ],
        alias: ALIAS.address,
        othersOnIt: false,
      },
      { situation: 'a mail to a client with your alias in Cc', messages: CC_THE_ALIAS, alias: ALIAS.address, othersOnIt: true },
      {
        // Bcc is never on a copy received, so only the client is named.
        situation: 'a mail to a client with your alias in Bcc',
        messages: [
          { id: 'sent', folder: SENT_ITEMS_ID, from: MAILBOX, to: [CLIENT] },
          { id: 'alias-copy', folder: INBOX_ID, from: MAILBOX, to: [CLIENT] },
        ],
        alias: ALIAS.address,
        othersOnIt: true,
      },
      {
        situation: 'a mail to your alias alone, with no alias set',
        messages: [
          { id: 'sent', folder: SENT_ITEMS_ID, from: MAILBOX, to: [ALIAS] },
          { id: 'alias-copy', folder: INBOX_ID, from: MAILBOX, to: [ALIAS] },
        ],
        alias: null,
        othersOnIt: true,
      },
    ])('$situation: someone else on it is $othersOnIt', ({ messages, alias, othersOnIt }) => {
      const { turns, yours } = read(messages, alias);
      expect(othersOn(turns, yours)).toBe(othersOnIt);
    });
  });
});
