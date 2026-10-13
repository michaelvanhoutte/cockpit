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
// Items folder, the listing of marked messages, one message in full, and a
// `PATCH` of its flag or categories, conditional on `If-Match` as Exchange
// makes it. Nothing here ships.
//

/** The folders a stand-in mailbox holds a message in. */
const INBOX = 'stub-inbox-folder';
const DELETED_ITEMS = 'stub-deleteditems-folder';

/**
 * What every stand-in mailbox starts with: two flagged messages, one plain text
 * and one HTML, one carrying the category Cockpit with no subject, and one
 * nobody marked.
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
  ];
}

let versions = 0;

function message(id, { subject, from, text, html, flagged = false, categories = [], at, folder = INBOX }) {
  return {
    id,
    parentFolderId: folder,
    receivedDateTime: at,
    subject,
    categories,
    flag: { flagStatus: flagged ? 'flagged' : 'notFlagged' },
    from: { emailAddress: { name: from.name, address: from.address } },
    body: html === undefined ? { contentType: 'text', content: text } : { contentType: 'html', content: html },
    webLink: `https://outlook.office365.com/owa/?ItemID=${encodeURIComponent(id)}&exvsurl=1&viewmodel=ReadMessageItem`,
    version: ++versions,
  };
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
    if (!mailboxes.has(email)) mailboxes.set(email, { messages: seededMessages(), asked: [], counter: 0 });
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
    const marked = mailbox.messages.filter((one) =>
      flagged
        ? one.flag.flagStatus === 'flagged'
        : category
          ? one.categories.some((name) => name.toLowerCase() === category.toLowerCase())
          : true,
    );
    const size = Number(url.searchParams.get('$top') ?? 10);
    const from = Number(url.searchParams.get('$skip') ?? 0);
    const page = marked.slice(from, from + size);
    const next = new URL(url);
    next.searchParams.set('$skip', String(from + size));
    return {
      ...(from + size < marked.length ? { '@odata.nextLink': `${origin}${next.pathname}${next.search}` } : {}),
      value: page.map((one) => {
        const { '@odata.etag': etag, id, parentFolderId, flag, categories } = shown(one);
        return { '@odata.etag': etag, id, parentFolderId, categories, flag };
      }),
    };
  }

  /** Answers a call under `/v1.0/me/`. */
  async function graph(url, request, response, origin) {
    const email = mailboxOfToken((request.headers.authorization ?? '').replace(/^Bearer /, ''));
    if (!email) return json(response, { error: { code: 'InvalidAuthenticationToken', message: 'Access token is empty or invalid.' } }, 401);
    const path = url.pathname.slice('/v1.0/me/'.length);
    const mailbox = heldMailbox(email);
    mailbox.asked.push(`${request.method} ${path}`);

    if (path === 'mailFolders/deleteditems') return json(response, { id: DELETED_ITEMS });
    if (path === 'messages' && request.method === 'GET') return json(response, listing(mailbox, url, origin));

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
      held.version = ++versions;
      return json(response, shown(held));
    }
    return json(response, shown(held));
  }

  /**
   * What a person does in Outlook, for a walk to do it from outside:
   * `POST /graph-stub/flag?email=&subject=&text=` flags a new message and
   * `/graph-stub/categorise?email=&subject=&text=` puts the category Cockpit on
   * one; `GET /graph-stub/message?email=&id=` reads back what a message's flag
   * and categories are now, and `/graph-stub/asked?email=` lists every call
   * the mailbox was asked, oldest first, so a walk can wait for a check.
   */
  function act(action, url, request, response) {
    const email = url.searchParams.get('email') ?? '';
    const mailbox = heldMailbox(email);
    if (action === 'asked') return json(response, mailbox.asked);
    if (action === 'message') {
      const held = mailbox.messages.find((one) => one.id === url.searchParams.get('id'));
      if (!held) return json(response, { error: 'no such message' }, 404);
      return json(response, { id: held.id, flagStatus: held.flag.flagStatus, categories: held.categories });
    }
    if (request.method !== 'POST') return json(response, { error: 'POST only' }, 405);
    mailbox.counter += 1;
    const subject = url.searchParams.get('subject') ?? (action === 'flag' ? 'Flagged just now' : 'Categorised just now');
    const added = message(`AAkALgStubNew${mailbox.counter}`, {
      subject,
      from: { name: 'Anna Peeters', address: 'anna@example.com' },
      text: url.searchParams.get('text') ?? `${subject}, a moment ago.`,
      flagged: action === 'flag',
      categories: action === 'categorise' ? ['Cockpit'] : [],
      at: new Date().toISOString(),
    });
    mailbox.messages.push(added);
    return json(response, { id: added.id });
  }

  return {
    /** Answers the request when it is one of this stand-in's, and says whether it did. */
    handle(url, request, response, origin) {
      if (url.pathname.startsWith('/v1.0/me/')) {
        void graph(url, request, response, origin);
        return true;
      }
      const acting = /^\/graph-stub\/(flag|categorise|message|asked)$/.exec(url.pathname);
      if (acting) {
        act(acting[1], url, request, response);
        return true;
      }
      return false;
    },
  };
}
