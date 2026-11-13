//
// A stand-in Microsoft Graph mailbox, for local development and the browser
// suite ("Connect Outlook from Settings, wherever the Microsoft client is
// set", issue 1048). The stub issuer (stub-issuer.mjs) serves it beside the
// sign-in, so one address stands in for Microsoft's sign-in and for Graph, as
// it stands in for Google's sign-in and Gmail.
//
// It answers the calls the Outlook connector makes (packages/connectors/
// outlook/README.md) at Graph's own paths under `/v1.0/me/`, read with an access
// token the issuer issued, so the token says whose mailbox it is: the Deleted
// Items and Sent Items folders, the listing of marked messages, the messages of
// one conversation (`$filter=conversationId eq`) or received since a time
// (`$filter=receivedDateTime ge`, `$orderby=receivedDateTime`, "Outlook follows
// the flagged conversation as Gmail does", issue 1707), one message in full, and
// a `PATCH` of its flag or categories, conditional on `If-Match` as Exchange
// makes it, and the drafts *Email…* makes (`POST /me/messages`, `POST
// /me/messages/{id}/createReply`, "Email… makes an Outlook draft the Item then
// follows", issue 1709), and the mail sent from the mailbox (`GET
// /me/mailFolders/sentitems/messages`, "Follow a sent email… in Capture", issue 1710).
// Nothing here ships.
//

/** The folders a stand-in mailbox holds a message in. */
const INBOX = 'stub-inbox-folder';
const DELETED_ITEMS = 'stub-deleteditems-folder';
const SENT_ITEMS = 'stub-sentitems-folder';
const DRAFTS = 'stub-drafts-folder';

/**
 * What every stand-in mailbox starts with: two flagged messages, one plain text
 * and one HTML, one carrying the category Cockpit with no subject, one nobody
 * marked, and three sent from the mailbox, which Sent Items holds.
 */
function seededMessages() {
  return [
    message('AAkALgStubQuarterly', {
      subject: 'Supplier contract to review',
      from: { name: 'Anna Peeters', address: 'anna@example.com' },
      text: 'Can you send me the Q3 figures before Friday?\n\nThanks, Anna',
      flagged: true,
      at: '2026-10-01T08:30:00Z',
    }),
    message('AAkALgStubLunch', {
      subject: 'Offsite dates for November',
      from: { name: '', address: 'pieter@example.com' },
      html: '<div>Which <b>November</b> dates suit you for the offsite?</div><div>Pieter</div>',
      flagged: true,
      at: '2026-10-02T12:00:00Z',
    }),
    message('AAkALgStubContract', {
      subject: '',
      from: { name: 'Lotte Janssens', address: 'lotte@example.com' },
      text: 'The lease is signed - please file it.',
      categories: ['Cockpit'],
      at: '2026-10-03T09:00:00Z',
    }),
    message('AAkALgStubNewsletter', {
      subject: 'Your weekly digest',
      from: { name: 'The Digest', address: 'digest@example.com' },
      text: 'Nothing here needs following up.',
      at: '2026-10-04T07:00:00Z',
    }),
    message('AAkALgStubSentKitchen', {
      subject: 'Quote for the kitchen renovation',
      from: ME,
      to: [{ name: 'Marc Lambrecht', address: 'marc@example.com' }],
      text: 'Hi Marc, attached is the quote we spoke about on Monday. Let me know what you think.',
      at: '2026-10-08T09:15:00Z',
      folder: SENT_ITEMS,
    }),
    message('AAkALgStubSentOffer', {
      subject: 'Offer for the new office lease',
      from: ME,
      to: [{ name: 'Sofie Maes', address: 'sofie@example.com' }, { name: '', address: 'legal@example.com' }],
      text: 'Sofie, our offer for the lease is below. We can sign before the end of the month.',
      at: '2026-10-06T14:40:00Z',
      folder: SENT_ITEMS,
    }),
    message('AAkALgStubSentDinner', {
      subject: 'Dinner with Steven Noels',
      from: ME,
      to: [{ name: 'Steven Noels', address: 'steven@example.com' }],
      text: 'Steven, are you free one evening next week for dinner?',
      at: '2026-10-05T18:05:00Z',
      folder: SENT_ITEMS,
    }),
  ];
}

/** The mailbox owner, as the mail they sent names them: the stand-in does not know the address, so the display name stands in. */
const ME = { name: 'Michael', address: 'michael@example.com' };

let versions = 0;

function message(id, { subject, from, to = [ME], text, html, flagged = false, categories = [], at, folder = INBOX, conversation = `stub-conversation-of-${id}` }) {
  return {
    id,
    conversationId: conversation,
    isDraft: false,
    bodyPreview: (html === undefined ? text : html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 255),
    parentFolderId: folder,
    receivedDateTime: at,
    sentDateTime: at,
    toRecipients: to.map(({ name, address }) => ({ emailAddress: { name, address } })),
    subject,
    categories,
    flag: { flagStatus: flagged ? 'flagged' : 'notFlagged' },
    from: { emailAddress: { name: from.name, address: from.address } },
    body: html === undefined ? { contentType: 'text', content: text } : { contentType: 'html', content: html },
    // What the message adds to its conversation: the stand-in's messages quote nothing, so it is the body.
    uniqueBody: html === undefined ? { contentType: 'text', content: text } : { contentType: 'html', content: html },
    webLink: `https://outlook.office365.com/owa/?ItemID=${encodeURIComponent(id)}&exvsurl=1&viewmodel=ReadMessageItem`,
    version: ++versions,
  };
}

/**
 * What a body's message adds to its conversation (`uniqueBody`, "the part of the
 * body of the message that is unique to the current message",
 * https://learn.microsoft.com/en-us/graph/api/resources/message?view=graph-rest-1.0):
 * everything above the earlier email a reply quotes under its rule (issue 1732).
 */
function uniqueOf(body) {
  if (body.contentType !== 'html') return body;
  return { contentType: 'html', content: body.content.replace(/<hr\b[\s\S]*?(?=<\/body>|$)/i, '') };
}

/** What Graph answers of a message: its fields, and the version it is at. */
function shown(held) {
  const { version, ...fields } = held;
  return { '@odata.etag': `W/"stub-${version}"`, ...fields };
}

/**
 * The stand-in, handed what it cannot know alone: which mailbox an access
 * token belongs to, and the response helper the issuer answers with.
 */
export function createStubGraph({ mailboxOfToken, json }) {
  /** Kept for the life of the issuer, so what is done to a mailbox is still there when the next check reads it. */
  const mailboxes = new Map();
  function heldMailbox(email) {
    if (!mailboxes.has(email)) mailboxes.set(email, { messages: seededMessages(), asked: [], counter: 0, email });
    return mailboxes.get(email);
  }

  function body(request) {
    return new Promise((resolve) => {
      let text = '';
      request.on('data', (chunk) => (text += chunk));
      request.on('end', () => resolve(text));
    });
  }

  /** The listing, with the filter Graph is given read for the mark it names. */
  function listing(mailbox, url, origin) {
    const filter = url.searchParams.get('$filter') ?? '';
    const flagged = /flag\/flagStatus eq 'flagged'/.test(filter);
    const category = /categories\/any\(c:c eq '([^']+)'\)/.exec(filter)?.[1];
    const conversation = /conversationId eq '((?:[^']|'')*)'/.exec(filter)?.[1]?.replace(/''/g, "'");
    const since = /receivedDateTime ge (\S+)/.exec(filter)?.[1];
    const marked = mailbox.messages.filter((one) => {
      if (conversation !== undefined) return one.conversationId === conversation;
      if (since !== undefined) return Date.parse(one.receivedDateTime) >= Date.parse(since);
      return flagged
        ? one.flag.flagStatus === 'flagged'
        : category
          ? one.categories.some((name) => name.toLowerCase() === category.toLowerCase())
          : true;
    });
    if (url.searchParams.get('$orderby') === 'receivedDateTime') {
      marked.sort((a, b) => Date.parse(a.receivedDateTime) - Date.parse(b.receivedDateTime));
    }
    const select = url.searchParams.get('$select')?.split(',') ?? ['id', 'parentFolderId', 'flag', 'categories', 'conversationId'];
    const size = Number(url.searchParams.get('$top') ?? 10);
    const from = Number(url.searchParams.get('$skip') ?? 0);
    const page = marked.slice(from, from + size);
    const next = new URL(url);
    next.searchParams.set('$skip', String(from + size));
    return {
      ...(from + size < marked.length ? { '@odata.nextLink': `${origin}${next.pathname}${next.search}` } : {}),
      value: page.map((one) => {
        const whole = shown(one);
        return { '@odata.etag': whole['@odata.etag'], ...Object.fromEntries(select.map((field) => [field, whole[field]])) };
      }),
    };
  }

  /** `GET /me/mailFolders/sentitems/messages`: what is in Sent Items, not a draft, newest `sentDateTime` first, the first `$top` of them. */
  function sentListing(mailbox, url) {
    const select = url.searchParams.get('$select')?.split(',') ?? ['id'];
    const size = Number(url.searchParams.get('$top') ?? 10);
    const sent = mailbox.messages
      .filter((one) => one.parentFolderId === SENT_ITEMS && !one.isDraft)
      .sort((a, b) => Date.parse(b.sentDateTime) - Date.parse(a.sentDateTime))
      .slice(0, size);
    return { value: sent.map((one) => Object.fromEntries(select.map((field) => [field, shown(one)[field]]))) };
  }

  /**
   * `POST /me/messages` and `POST /me/messages/{id}/createReply`: a draft in the
   * Drafts folder, in a conversation of its own or the message's, answered as
   * Graph answers it (id, conversationId, webLink). A person then sends it
   * (`/graph-stub/send-draft`) or deletes it (`/graph-stub/delete-draft`).
   */
  async function makeDraft(mailbox, replyTo, request, response) {
    let asked;
    try {
      asked = JSON.parse((await body(request)) || '{}');
    } catch {
      return json(response, { error: { code: 'ErrorInvalidRequest', message: 'The request body is not valid JSON.' } }, 400);
    }
    const original = replyTo === null ? undefined : mailbox.messages.find((one) => one.id === replyTo);
    if (replyTo !== null && !original) {
      return json(response, { error: { code: 'ErrorItemNotFound', message: 'The specified object was not found in the store.' } }, 404);
    }
    mailbox.counter += 1;
    const draft = message(`AAkALgStubDraft${mailbox.counter}`, {
      subject: original ? `RE: ${original.subject}` : (asked.subject ?? ''),
      from: { name: 'Michael', address: mailbox.email },
      // A reply holds the email it answers, quoted, in HTML as Outlook writes it; a new draft, the text it is handed.
      ...(original
        ? {
            html: `<html><head></head><body><div><br></div><hr><div id="divRplyFwdMsg"><b>From:</b> ${original.from.emailAddress.name}<br><b>Sent:</b> ${original.sentDateTime}</div><div>${original.bodyPreview}</div></body></html>`,
          }
        : { text: asked.body?.content ?? '' }),
      at: new Date().toISOString(),
      folder: DRAFTS,
      conversation: original?.conversationId,
    });
    draft.isDraft = true;
    draft.uniqueBody = uniqueOf(draft.body);
    mailbox.messages.push(draft);
    json(response, shown(draft), 201);
  }

  /** Answers a call under `/v1.0/me/`. */
  async function graph(url, request, response, origin) {
    const email = mailboxOfToken((request.headers.authorization ?? '').replace(/^Bearer /, ''));
    if (!email) return json(response, { error: { code: 'InvalidAuthenticationToken', message: 'Access token is empty or invalid.' } }, 401);
    const path = url.pathname.slice('/v1.0/me/'.length);
    const mailbox = heldMailbox(email);
    mailbox.asked.push(`${request.method} ${path}`);
    if (mailbox.refusing) {
      return json(response, { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } }, mailbox.refusing);
    }

    if (path === 'mailFolders/deleteditems') return json(response, { id: DELETED_ITEMS });
    if (path === 'mailFolders/sentitems') return json(response, { id: SENT_ITEMS });
    if (path === 'mailFolders/sentitems/messages' && request.method === 'GET') return json(response, sentListing(mailbox, url));
    if (path === 'messages' && request.method === 'GET') return json(response, listing(mailbox, url, origin));
    if (path === 'messages' && request.method === 'POST') return makeDraft(mailbox, null, request, response);
    const replying = /^messages\/([^/]+)\/createReply$/.exec(path);
    if (replying && request.method === 'POST') return makeDraft(mailbox, decodeURIComponent(replying[1]), request, response);

    const one = /^messages\/(.+)$/.exec(path);
    const held = one && mailbox.messages.find((candidate) => candidate.id === decodeURIComponent(one[1]));
    if (!held) return json(response, { error: { code: 'ErrorItemNotFound', message: 'The specified object was not found in the store.' } }, 404);

    if (request.method === 'PATCH') {
      let change;
      try {
        change = JSON.parse((await body(request)) || '{}');
      } catch {
        return json(response, { error: { code: 'ErrorInvalidRequest', message: 'The request body is not valid JSON.' } }, 400);
      }
      const ifMatch = request.headers['if-match'];
      if (ifMatch && ifMatch !== shown(held)['@odata.etag']) {
        return json(response, { error: { code: 'ErrorIrresolvableConflict', message: 'The change key passed in the request does not match the current change key for the item.' } }, 412);
      }
      if (change.flag?.flagStatus) held.flag = { flagStatus: change.flag.flagStatus };
      if (Array.isArray(change.categories)) held.categories = change.categories;
      // A draft's body, which only a draft takes (message-update: "updatable only if isDraft = true").
      if (change.body) {
        if (!held.isDraft) return json(response, { error: { code: 'ErrorInvalidRequest', message: 'The body of a sent message cannot be changed.' } }, 400);
        held.body = { contentType: change.body.contentType, content: change.body.content };
        held.uniqueBody = uniqueOf(held.body);
        held.bodyPreview = String(change.body.content).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 255);
      }
      held.version = ++versions;
      return json(response, shown(held));
    }
    return json(response, shown(held));
  }

  /**
   * What a person does in Outlook, for a walk to do it from outside:
   * `POST /graph-stub/flag?email=&subject=&text=` flags a new message and
   * `/graph-stub/categorise?email=&subject=&text=` puts the category Cockpit on
   * one, each also carrying every `category=` given; `POST
   * /graph-stub/tag?email=&id=&category=` adds a category to a message already
   * there; `GET /graph-stub/message?email=&id=` reads back what a message's flag
   * and categories are now; `POST /graph-stub/reply?email=&conversation=&text=&from=`
   * adds a message to a conversation (`sent` makes it one sent from the mailbox, in
   * Sent Items), answering its id, and `flag`, `categorise` also take `conversation=`
   * to start in one; `POST /graph-stub/refuse?email=&status=403` makes
   * every later call of that mailbox answer that status (`status=0` ends it), to
   * see a failed check's status in its connection's history; and `/graph-stub/asked?email=` lists every call
   * the mailbox was asked, oldest first, so a walk can wait for a check; `POST
   * /graph-stub/send-draft?email=&id=` sends a draft Cockpit had the mailbox make
   * where it stands (a message in Sent Items now, with the id it had), `POST
   * /graph-stub/delete-draft?email=&id=` deletes it unsent (to Deleted Items), `POST
   * /graph-stub/edit-draft?email=&id=&text=` types words at its top, and
   * `GET /graph-stub/drafts?email=` lists the drafts the mailbox holds, with their bodies.
   */
  function act(action, url, request, response) {
    const email = url.searchParams.get('email') ?? '';
    const mailbox = heldMailbox(email);
    if (action === 'asked') return json(response, mailbox.asked);
    if (action === 'drafts') {
      return json(response, mailbox.messages.filter((one) => one.isDraft).map((one) => ({ id: one.id, subject: one.subject, conversationId: one.conversationId, body: one.body })));
    }
    if (action === 'message') {
      const held = mailbox.messages.find((one) => one.id === url.searchParams.get('id'));
      if (!held) return json(response, { error: 'no such message' }, 404);
      return json(response, { id: held.id, flagStatus: held.flag.flagStatus, categories: held.categories, conversationId: held.conversationId });
    }
    if (request.method !== 'POST') return json(response, { error: 'POST only' }, 405);
    if (action === 'refuse') {
      mailbox.refusing = Number(url.searchParams.get('status') ?? 0) || null;
      return json(response, { refusing: mailbox.refusing });
    }
    if (action === 'edit-draft') {
      // A person typing in the draft in Outlook (issue 1732): these words above whatever it holds, so Cockpit finds it changed.
      const draft = mailbox.messages.find((one) => one.id === url.searchParams.get('id') && one.isDraft);
      if (!draft) return json(response, { error: 'no such draft' }, 404);
      const words = url.searchParams.get('text') ?? '';
      draft.body =
        draft.body.contentType === 'html'
          ? { contentType: 'html', content: draft.body.content.replace(/<body([^>]*)>/i, (open) => `${open}<div>${words.replace(/</g, '&lt;')}</div>`) }
          : { contentType: 'text', content: `${words}\n${draft.body.content}` };
      draft.uniqueBody = uniqueOf(draft.body);
      draft.version = ++versions;
      return json(response, { id: draft.id, body: draft.body });
    }
    if (action === 'send-draft' || action === 'delete-draft') {
      const draft = mailbox.messages.find((one) => one.id === url.searchParams.get('id') && one.isDraft);
      if (!draft) return json(response, { error: 'no such draft' }, 404);
      if (action === 'send-draft') {
        draft.isDraft = false;
        draft.parentFolderId = SENT_ITEMS;
        draft.receivedDateTime = new Date().toISOString();
        draft.sentDateTime = draft.receivedDateTime;
      } else {
        draft.parentFolderId = DELETED_ITEMS;
      }
      draft.version = ++versions;
      return json(response, { id: draft.id, folder: draft.parentFolderId });
    }
    const extra = url.searchParams.getAll('category');
    if (action === 'tag') {
      const held = mailbox.messages.find((one) => one.id === url.searchParams.get('id'));
      if (!held) return json(response, { error: 'no such message' }, 404);
      held.categories = [...held.categories, ...extra];
      held.version = ++versions;
      return json(response, { id: held.id, categories: held.categories });
    }
    if (action === 'reply') {
      mailbox.counter += 1;
      const sent = url.searchParams.has('sent');
      const from = /^(.*?)\s*<([^>]+)>$/.exec(url.searchParams.get('from') ?? '');
      const reply = message(`AAkALgStubNew${mailbox.counter}`, {
        subject: 'Re: a conversation',
        from: sent ? { name: 'Michael', address: email } : { name: from?.[1] ?? 'Steven Noels', address: from?.[2] ?? 'steven@example.com' },
        text: url.searchParams.get('text') ?? 'A reply, a moment ago.',
        at: new Date().toISOString(),
        folder: sent ? SENT_ITEMS : INBOX,
        conversation: url.searchParams.get('conversation') ?? undefined,
      });
      mailbox.messages.push(reply);
      return json(response, { id: reply.id, conversation: reply.conversationId });
    }
    mailbox.counter += 1;
    const subject = url.searchParams.get('subject') ?? (action === 'flag' ? 'Flagged just now' : 'Categorised just now');
    const added = message(`AAkALgStubNew${mailbox.counter}`, {
      subject,
      from: { name: 'Anna Peeters', address: 'anna@example.com' },
      text: url.searchParams.get('text') ?? `${subject}, a moment ago.`,
      flagged: action === 'flag',
      categories: [...(action === 'categorise' ? ['Cockpit'] : []), ...extra],
      at: new Date().toISOString(),
      conversation: url.searchParams.get('conversation') ?? undefined,
    });
    mailbox.messages.push(added);
    return json(response, { id: added.id, conversation: added.conversationId });
  }

  return {
    /** Answers the request when it is one of this stand-in's, and says whether it did. */
    handle(url, request, response, origin) {
      if (url.pathname.startsWith('/v1.0/me/')) {
        void graph(url, request, response, origin);
        return true;
      }
      const acting = /^\/graph-stub\/(flag|categorise|tag|message|asked|refuse|reply|drafts|send-draft|delete-draft|edit-draft)$/.exec(url.pathname);
      if (acting) {
        act(acting[1], url, request, response);
        return true;
      }
      return false;
    },
  };
}
