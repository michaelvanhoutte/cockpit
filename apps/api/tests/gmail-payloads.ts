/**
 * Gmail's answers to the three calls the connector reads, in the shapes
 * Gmail answers them ("Bring in the conversations already labelled Cockpit as
 * tasks", issue 725): `users.labels.list`, `users.threads.list` and
 * `users.threads.get` with `format=full`, plus `users.getProfile`.
 *
 * Every field Gmail sends is kept, whether the connector reads it or not, so
 * these stay comparable to a live answer field for field - which is what the
 * scheduled contract test does against a real mailbox
 * (tests/contract/gmail.test.ts). A failure there means these describe a
 * Gmail that no longer exists, and updating them is priority work.
 *
 * Builders rather than constants, because each case needs its own
 * conversations; the shapes are the same in every one.
 */

/** The id Gmail gives a label somebody made, as it names the first one. */
export const COCKPIT_LABEL_ID = 'Label_3409857126543';

/** What a body is sent as: UTF-8, base64 in its URL-safe alphabet, unpadded. */
export function bodyData(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** `users.labels.list`: the system labels every mailbox has, and Cockpit where it was made. */
export function labelsAnswer({ cockpit = true, named = 'Cockpit' }: { cockpit?: boolean; named?: string } = {}) {
  return {
    labels: [
      { id: 'CHAT', name: 'CHAT', messageListVisibility: 'hide', labelListVisibility: 'labelHide', type: 'system' },
      { id: 'SENT', name: 'SENT', type: 'system' },
      { id: 'INBOX', name: 'INBOX', type: 'system' },
      { id: 'IMPORTANT', name: 'IMPORTANT', messageListVisibility: 'hide', labelListVisibility: 'labelHide', type: 'system' },
      { id: 'TRASH', name: 'TRASH', messageListVisibility: 'hide', labelListVisibility: 'labelHide', type: 'system' },
      { id: 'UNREAD', name: 'UNREAD', type: 'system' },
      ...(cockpit
        ? [
            {
              id: COCKPIT_LABEL_ID,
              name: named,
              messageListVisibility: 'show',
              labelListVisibility: 'labelShow',
              type: 'user',
            },
          ]
        : []),
    ],
  };
}

/** `users.getProfile`. */
export function profileAnswer(historyId = '4815162342') {
  return { emailAddress: 'anna@example.com', messagesTotal: 1532, threadsTotal: 1170, historyId };
}

/** `users.threads.list`: one page of ids, and where the next one starts. */
export function threadsPage(threadIds: readonly string[], nextPageToken?: string) {
  return {
    threads: threadIds.map((id) => ({ id, snippet: `A snippet of ${id}`, historyId: '4815162300' })),
    ...(nextPageToken ? { nextPageToken } : {}),
    resultSizeEstimate: threadIds.length,
  };
}

interface MessageOptions {
  readonly id: string;
  readonly sentAt: string;
  readonly subject?: string;
  readonly from?: string;
  readonly labelled?: boolean;
  /** The parts of the message: one plain text, one HTML, or both as multipart/alternative. */
  readonly plain?: string;
  readonly html?: string;
}

function header(name: string, value: string) {
  return { name, value };
}

/** One message as `users.threads.get` with `format=full` carries it. */
export function message(threadId: string, options: MessageOptions) {
  const headers = [
    header('Delivered-To', 'anna@example.com'),
    header('Date', new Date(options.sentAt).toUTCString()),
    header('From', options.from ?? 'Pieter Claes <pieter@example.com>'),
    header('To', 'anna@example.com'),
    ...(options.subject === undefined ? [] : [header('Subject', options.subject)]),
    header('Message-ID', `<${options.id}@mail.example.com>`),
  ];
  const plainPart = (partId: string, text: string) => ({
    partId,
    mimeType: 'text/plain',
    filename: '',
    headers: [header('Content-Type', 'text/plain; charset="UTF-8"')],
    body: { size: text.length, data: bodyData(text) },
  });
  const htmlPart = (partId: string, html: string) => ({
    partId,
    mimeType: 'text/html',
    filename: '',
    headers: [header('Content-Type', 'text/html; charset="UTF-8"')],
    body: { size: html.length, data: bodyData(html) },
  });
  const payload =
    options.plain !== undefined && options.html !== undefined
      ? {
          partId: '',
          mimeType: 'multipart/alternative',
          filename: '',
          headers: [...headers, header('Content-Type', 'multipart/alternative; boundary="000000000000abc"')],
          body: { size: 0 },
          parts: [plainPart('0', options.plain), htmlPart('1', options.html)],
        }
      : options.html !== undefined
        ? { ...htmlPart('', options.html), headers: [...headers, ...htmlPart('', '').headers] }
        : { ...plainPart('', options.plain ?? ''), headers: [...headers, ...plainPart('', '').headers] };
  return {
    id: options.id,
    threadId,
    labelIds: options.labelled === false ? ['INBOX', 'UNREAD'] : ['INBOX', 'UNREAD', COCKPIT_LABEL_ID],
    snippet: (options.plain ?? '').slice(0, 100),
    sizeEstimate: 4096,
    historyId: '4815162300',
    internalDate: String(Date.parse(options.sentAt)),
    payload,
  };
}

/** `users.threads.get` with `format=full`: the conversation and every message in it, oldest first. */
export function threadAnswer(id: string, messages: readonly ReturnType<typeof message>[]) {
  return { id, historyId: '4815162300', messages };
}

/** The commonest conversation: one labelled plain-text message. */
export function plainThread(id: string, subject = `About ${id}`, text = `The text of ${id}.`) {
  return threadAnswer(id, [message(id, { id, sentAt: '2026-10-01T08:30:00Z', subject, plain: text })]);
}
