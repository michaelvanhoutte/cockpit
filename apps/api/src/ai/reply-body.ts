import { z } from 'zod';

/**
 * Reading what the model wrote as a reply ("Mail follow-up: Reply… in Gmail
 * makes an empty draft: have Claude write it from the Item, your points and the
 * conversation", issue 1730). Pure and apart from the call, as
 * `sentence-offers.ts` is: every way an answer can be unusable ends in no draft
 * at all, never in a draft of something else.
 */

/** The body as the draft holds it, or why Claude wrote none - which makes no draft. */
export type ReplyWritten = { body: string } | { discarded: string };

/**
 * The most characters a body may run to. The call is held to 4,000 tokens, room for the reasoning as well as the answer; a body
 * past this is not a reply to an email, whatever the cap allowed.
 */
export const REPLY_BODY_LIMIT = 8_000;

const answerShape = z.object({ language: z.string(), body: z.string() });

/**
 * Reads an answer into the body, or says why there is none. **Not filtered for
 * what a sender's mail may have steered into it**: it is a draft the person
 * reads before sending, and nothing here sends it.
 */
export function readReplyBody(raw: unknown): ReplyWritten {
  if (typeof raw !== 'string') return { discarded: 'the answer carried no text' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { discarded: 'the answer was not JSON' };
  }
  const answer = answerShape.safeParse(parsed);
  if (!answer.success) return { discarded: 'the answer was not a language and a body' };
  const body = answer.data.body.replace(/\r\n?/g, '\n').trim();
  if (body === '') return { discarded: 'the body was empty' };
  if (body.length > REPLY_BODY_LIMIT) return { discarded: 'the body was too long' };
  return { body };
}
