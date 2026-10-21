import { VERIFY_ORIGIN } from '@cockpit/connector-twilio';

/**
 * Twilio Verify on the faked network, beside the issuer, Gmail and Graph
 * (`./issuer.ts`, "Connect a phone in Settings by confirming a code texted to
 * it", issue 1335): a verification per number, answering the two calls the
 * Twilio connector makes with Verify's own statuses - a check of a number
 * nothing was sent to is a 404, a wrong code leaves the verification pending,
 * and the fifth wrong code ends it.
 *
 * Nothing here is Cockpit's: the code, its expiry and its attempt limit are
 * Verify's, which is why Cockpit keeps no pending state and why a case about
 * a code that has lapsed makes Verify forget the number rather than moving
 * Cockpit's clock.
 */
export const VERIFY_API = VERIFY_ORIGIN;

/** The code every verification here is approved with. */
export const THE_CODE = '123456';

/** What Verify was asked, oldest first: the call, the number and the code a check carried. */
export const verifyCalls: { call: 'send' | 'check'; to: string; code?: string }[] = [];

/** How Verify answers each call: as it does, with a refusal, or with a failure of its own. */
const answering = { send: 'texts' as 'texts' | 'refuses' | 'is down', check: 'answers' as 'answers' | 'is down' };

/** The wrong codes tried against each number Verify has a verification for. */
const pending = new Map<string, number>();

/** Forgets every verification and what it was asked - each case starts from nothing. */
export function verifyIsEmpty(): void {
  verifyCalls.length = 0;
  pending.clear();
  answering.send = 'texts';
  answering.check = 'answers';
}

/** How the next calls are answered. */
export function verifyWill(how: Partial<typeof answering>): void {
  Object.assign(answering, how);
}

/** The ten minutes passing: Verify no longer has a verification for the number. */
export function verifyForgets(number: string): void {
  pending.delete(number);
}

/** How many texts Verify was asked to send. */
export function textsSent(): number {
  return verifyCalls.filter((one) => one.call === 'send').length;
}

/** Answers a call to Verify. */
export async function verifyAnswer(url: URL, init?: RequestInit): Promise<Response> {
  const form = new URLSearchParams(init?.body as URLSearchParams);
  const to = form.get('To') ?? '';
  const sending = url.pathname.endsWith('/Verifications');
  verifyCalls.push({ call: sending ? 'send' : 'check', to, ...(sending ? {} : { code: form.get('Code') ?? '' }) });

  const credentials = new Headers(init?.headers).get('authorization') ?? '';
  if (!credentials.startsWith('Basic ')) {
    return Response.json({ code: 20003, message: 'Authenticate', status: 401 }, { status: 401 });
  }

  if (sending) {
    if (answering.send === 'is down') return Response.json({ code: 20500, message: 'Internal Server Error', status: 500 }, { status: 500 });
    if (answering.send === 'refuses') {
      return Response.json({ code: 60203, message: 'Max send attempts reached', status: 429 }, { status: 429 });
    }
    pending.set(to, 0);
    return Response.json({ sid: 'VE0001', to, channel: 'sms', status: 'pending', valid: false }, { status: 201 });
  }

  if (answering.check === 'is down') return Response.json({ code: 20500, message: 'Internal Server Error', status: 500 }, { status: 500 });
  if (!pending.has(to)) {
    return Response.json({ code: 20404, message: 'The requested resource was not found', status: 404 }, { status: 404 });
  }
  if (form.get('Code') === THE_CODE) {
    pending.delete(to);
    return Response.json({ sid: 'VE0001', to, channel: 'sms', status: 'approved', valid: true });
  }
  const wrong = pending.get(to)! + 1;
  if (wrong >= 5) pending.delete(to);
  else pending.set(to, wrong);
  return Response.json({ sid: 'VE0001', to, channel: 'sms', status: 'pending', valid: false });
}
