/**
 * Microsoft Graph's answers to the calls the connector reads, in the shapes
 * Graph's documentation shows them ("Build Outlook as a connector package on
 * the SDK, unregistered", issue 1046): `GET /me/mailFolders/deleteditems`,
 * `GET /me/messages` with `$filter` and `$select`, and `GET /me/messages/{id}` -
 * and, to put the mark back or take it off ("Take the flag or category off in
 * Outlook when its task is done in Cockpit", issue 1047), the category list read
 * with its version and a `PATCH` refused for a version that changed.
 * The identifiers are immutable ones (`Prefer: IdType="ImmutableId"`), which
 * begin `AAkAL` and are long; the shortened ones here keep the shape of a
 * long opaque string.
 *
 * Every field Graph sends for the fields asked for is kept, so these stay
 * comparable to a live answer field for field - which is what the contract
 * test does against a real mailbox (tests/contract/recorded-answers.test.ts). A
 * failure there means these describe a Graph that no longer exists, and
 * updating them is priority work.
 *
 * Builders rather than constants, because each case needs its own messages;
 * the shapes are the same in every one.
 */

export const DELETED_ITEMS_ID = 'AAMkADdeleteditemsFolderIdAAA=';
export const INBOX_ID = 'AAMkADinboxFolderIdAAAA=';
export const ARCHIVE_ID = 'AAMkADarchiveFolderIdAAA=';

/** `GET /me/mailFolders/deleteditems?$select=id`. */
export function deletedItemsAnswer() {
  return {
    '@odata.context': "https://graph.microsoft.com/v1.0/$metadata#users('anna%40example.com')/mailFolders/$entity",
    id: DELETED_ITEMS_ID,
  };
}

export interface MessageOptions {
  readonly id: string;
  readonly folder?: string;
  /** Flag status; absent is not flagged. */
  readonly flag?: 'flagged' | 'complete' | 'notFlagged';
  readonly categories?: readonly string[];
  readonly subject?: string | null;
  /** `null` for a draft with no sender. */
  readonly from?: { name?: string; address: string } | null;
  readonly text?: string;
  readonly html?: string;
  readonly receivedAt?: string;
  /** The version Graph names the message at (@odata.etag), which changes with every change to it. */
  readonly version?: string;
}

/** One message with every field the connector may ask for. */
export function message(options: MessageOptions) {
  const html = options.html !== undefined;
  const content = html ? options.html! : (options.text ?? `The text of ${options.id}.`);
  const from = options.from === undefined ? { name: 'Pieter Claes', address: 'pieter@example.com' } : options.from;
  return {
    '@odata.etag': options.version ?? 'W/"CQAAABYAAAB3Gs0yUuqeSKdKbXRSf8D4AAGH0d9d"',
    id: options.id,
    parentFolderId: options.folder ?? INBOX_ID,
    receivedDateTime: options.receivedAt ?? '2026-10-01T08:30:00Z',
    subject: options.subject === undefined ? `About ${options.id}` : (options.subject ?? ''),
    categories: [...(options.categories ?? [])],
    flag: { flagStatus: options.flag ?? 'notFlagged' },
    from: from ? { emailAddress: { name: from.name ?? '', address: from.address } } : null,
    body: { contentType: html ? 'html' : 'text', content },
    webLink: `https://outlook.office365.com/owa/?ItemID=${encodeURIComponent(options.id)}&exvsurl=1&viewmodel=ReadMessageItem`,
  };
}

/** `GET /me/messages/{id}?$select=categories`: the list, and the version it was read at. */
export function categoriesAnswer(options: MessageOptions) {
  const { '@odata.etag': version, id, categories } = message(options);
  return {
    '@odata.context': "https://graph.microsoft.com/v1.0/$metadata#users('anna%40example.com')/messages(categories)/$entity",
    '@odata.etag': version,
    id,
    categories,
  };
}

/** `PATCH /me/messages/{id}` refused because the `If-Match` version is no longer the message's. */
export const VERSION_CHANGED = {
  error: {
    code: 'ErrorIrresolvableConflict',
    message: 'The send or update operation could not be performed because the change key passed in the request does not match the current change key for the item.',
  },
};

/** `GET /me/messages?$select=id,parentFolderId,flag,categories`: one page, and where the next one is. */
export function messagesPage(messages: readonly ReturnType<typeof message>[], nextLink?: string) {
  return {
    '@odata.context': "https://graph.microsoft.com/v1.0/$metadata#users('anna%40example.com')/messages(id,parentFolderId,flag,categories)",
    ...(nextLink ? { '@odata.nextLink': nextLink } : {}),
    value: messages.map(({ id, parentFolderId, flag, categories }) => ({
      '@odata.etag': 'W/"CQAAABYAAAB3Gs0yUuqeSKdKbXRSf8D4AAGH0d9d"',
      id,
      parentFolderId,
      categories,
      flag,
    })),
  };
}

/** The token endpoint's answer to a refresh: Microsoft rotates the refresh token every time. */
export function refreshAnswer(refreshToken = 'a-rotated-refresh-token') {
  return {
    token_type: 'Bearer',
    scope: 'Mail.ReadWrite openid profile email',
    expires_in: 3599,
    ext_expires_in: 3599,
    access_token: 'a-good-access-token',
    refresh_token: refreshToken,
  };
}

/** The token endpoint refusing a refresh because the organisation withdrew consent (AADSTS65001). */
export const CONSENT_WITHDRAWN = {
  error: 'invalid_grant',
  error_description:
    'AADSTS65001: The user or administrator has not consented to use the application with ID \'00000000-0000-0000-0000-000000000000\'. Trace ID: x Correlation ID: y Timestamp: 2026-10-09 11:00:00Z',
  error_codes: [65001],
  timestamp: '2026-10-09 11:00:00Z',
  trace_id: 'x',
  correlation_id: 'y',
};

/** The token endpoint refusing a refresh token it no longer honours. */
export const INVALID_GRANT = {
  error: 'invalid_grant',
  error_description: 'AADSTS70000: The provided value for the input parameter \'refresh_token\' is not valid.',
  error_codes: [70000],
};
