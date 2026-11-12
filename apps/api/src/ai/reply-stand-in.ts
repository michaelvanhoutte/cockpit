import type { ReplyBrief } from './prompts/draft-a-reply.v1.js';
import type { ReplyWritten } from './reply-body.js';

/**
 * What the two local stacks write for a reply in place of Claude
 * (`DRAFT_STAND_IN`, "Mail follow-up: Reply… in Gmail makes an empty draft…",
 * issue 1730): scripts/dev.mjs and scripts/e2e-stack.mjs hold a stand-in mailbox
 * and no key worth spending, as they hold a stand-in for Whisper
 * (`transcription/index.ts`). **Nothing is asked of a model and nothing is
 * recorded**, so the request, the read of the conversation, the draft and the
 * tab are driven for real; what the real model writes is the contract tier's
 * question (tests/contract/draft-a-reply.v1.test.ts).
 *
 * The body says plainly that a stand-in wrote it, and echoes the points and how
 * many messages it was shown, so a walk can tell its inputs arrived.
 */
export function standInReply(brief: ReplyBrief): ReplyWritten {
  const points = brief.points.trim();
  return {
    body: [
      'Hi,',
      '',
      points === '' ? '(no points given)' : `Points: ${points}`,
      `(Written by the stand-in for "${brief.title}", shown ${brief.messages.length} message${brief.messages.length === 1 ? '' : 's'}.)`,
      '',
      '[A gap for you to fill]',
    ].join('\n'),
  };
}
