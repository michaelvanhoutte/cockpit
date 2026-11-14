/**
 * LinkedIn's message notification emails, as Gmail answers them ("Follow the
 * LinkedIn conversation instead of the notification", issue 1711).
 *
 * **These are reconstructed, not captured.** No real LinkedIn notification was
 * available when this was written, so the shapes below follow LinkedIn's
 * notification email as publicly seen: sent as "<Name> via LinkedIn
 * <messages-noreply@linkedin.com>", a plain-text and an HTML part, the message
 * under the sender's name, a "View message" (Dutch: "Bekijk bericht") button
 * leading to `linkedin.com/messaging/thread/<id>/`, usually through LinkedIn's
 * `comm/` tracking address with a tracking query, and a footer about
 * notification emails. The wording and layout are an approximation, and the
 * connector reads them tolerantly for that reason. Replace these with a
 * captured email (names and addresses changed) as soon as there is one; the
 * scheduled contract test cannot vouch for them (tests/contract).
 *
 * The envelope - labels, headers, parts, ids - is Gmail's, built by
 * `message()` in gmail-payloads.ts, which the contract test does vouch for.
 */

import { message } from './gmail-payloads.js';

/** The conversation the notifications below are about: LinkedIn's own thread id, as it appears in the address. */
export const LINKEDIN_THREAD = '2-ZmFrZS10aHJlYWQtMQ==';

const TRACKING = 'midToken=AQEfakeMidToken&trk=eml-messaging_digest-body-0&trkEmail=eml-messaging_digest-body-null-0-null-null-fakeemail';

/** The three ways LinkedIn is seen to write the "View message" address. */
export type LinkStyle = 'direct' | 'comm' | 'redirect' | 'digest';

/** The token LinkedIn signs a digest's links with: never to be kept, so a test looks for it. */
export const OTP_TOKEN = 'FAKEOTPTOKEN-do-not-keep';

function addressOf(threadId: string, style: LinkStyle): string {
  // The digest's View message button: no slash before the query, a page tag and a sign-in token.
  if (style === 'digest') return `https://www.linkedin.com/comm/messaging/thread/${threadId}?lipi=urn%3Ali%3Apage%3Aemail_messaging_digest%3BfakeLipi&otpToken=${OTP_TOKEN}&midToken=AQEfakeMidToken`;
  if (style === 'direct') return `https://www.linkedin.com/messaging/thread/${threadId}/`;
  const comm = `https://www.linkedin.com/comm/messaging/thread/${threadId}/?${TRACKING}`;
  if (style === 'comm') return comm;
  // A tracking redirect that carries the comm address, percent-encoded, as its `url`.
  return `https://www.linkedin.com/e/v2?e=fake-e&t=plh&url=${encodeURIComponent(comm)}`;
}

const WORDS = {
  en: {
    subject: (name: string) => `${name} sent you a message`,
    button: 'View message',
    footer: 'You are receiving LinkedIn notification emails.',
    unsubscribe: 'Unsubscribe',
  },
  nl: {
    subject: (name: string) => `${name} heeft je een bericht gestuurd`,
    button: 'Bekijk bericht',
    footer: 'Je ontvangt meldingsmails van LinkedIn.',
    unsubscribe: 'Afmelden',
  },
} as const;

export interface NotificationOptions {
  readonly id: string;
  readonly sentAt: string;
  readonly language?: 'en' | 'nl';
  /** LinkedIn's thread id the button leads to. */
  readonly thread?: string;
  readonly link?: LinkStyle;
  readonly name?: string;
  /** Which of LinkedIn's two message senders it came from: the direct notification, or the digest ("Frederik just messaged you"). */
  readonly sender?: 'direct' | 'digest';
  readonly text?: string;
  /** Sent without an HTML part, as some notification emails are. */
  readonly plainOnly?: boolean;
}

/** A message notification from LinkedIn, in a Gmail conversation of its own. */
export function linkedInNotification(gmailThread: string, options: NotificationOptions) {
  const language = options.language ?? 'en';
  const words = WORDS[language];
  const name = options.name ?? 'Steven Noels';
  const text = options.text ?? (language === 'en' ? 'Shall we have dinner on Thursday? I know a good place in Ghent.' : 'Zullen we donderdag samen gaan eten? Ik ken een goede plek in Gent.');
  const address = addressOf(options.thread ?? LINKEDIN_THREAD, options.link ?? 'comm');
  const unsubscribe = 'https://www.linkedin.com/e/v2?e=fake-e&t=uns&url=https%3A%2F%2Fwww.linkedin.com%2Fcomm%2Fpsettings%2Femail-unsubscribe';
  const plain = [name, '', text, '', `${words.button}: ${address}`, '', '---', words.footer, `${words.unsubscribe}: ${unsubscribe}`, '© 2026 LinkedIn Corporation'].join('\n');
  const html = [
    '<html><body><table><tr><td>',
    `<p style="font-weight:600">${name}</p>`,
    `<p>${text}</p>`,
    `<a href="${address.replace(/&/g, '&amp;')}" style="background:#0a66c2">${words.button}</a>`,
    `<p>${words.footer} <a href="${unsubscribe.replace(/&/g, '&amp;')}">${words.unsubscribe}</a></p>`,
    '<p>© 2026 LinkedIn Corporation</p>',
    '</td></tr></table></body></html>',
  ].join('\n');
  return message(gmailThread, {
    id: options.id,
    sentAt: options.sentAt,
    subject: options.sender === 'digest' ? `${name} just messaged you` : words.subject(name),
    from: `${name} via LinkedIn <${options.sender === 'digest' ? 'messaging-digest-noreply@linkedin.com' : 'messages-noreply@linkedin.com'}>`,
    labelled: false,
    plain,
    ...(options.plainOnly ? {} : { html }),
  });
}

/** A LinkedIn email that is no message notification: someone wants to connect. */
export function linkedInConnectionRequest(gmailThread: string, options: { id: string; sentAt: string }) {
  return message(gmailThread, {
    id: options.id,
    sentAt: options.sentAt,
    subject: 'Steven Noels wants to connect',
    from: 'Steven Noels via LinkedIn <invitations@linkedin.com>',
    labelled: false,
    plain: 'Steven Noels wants to connect\n\nAccept: https://www.linkedin.com/comm/mynetwork/invitations/accept/?invitationId=1&trk=eml\nView profile: https://www.linkedin.com/comm/in/stevennoels?trk=eml\n',
  });
}

/** A notification-shaped email whose button leads somewhere that is no LinkedIn messaging address. */
export function notificationLeadingTo(gmailThread: string, options: { id: string; sentAt: string; address: string; from?: string }) {
  return message(gmailThread, {
    id: options.id,
    sentAt: options.sentAt,
    subject: 'Steven Noels sent you a message',
    from: options.from ?? 'Steven Noels via LinkedIn <messages-noreply@linkedin.com>',
    labelled: false,
    plain: `Steven Noels\n\nShall we have dinner on Thursday?\n\nView message: ${options.address}\n`,
  });
}
