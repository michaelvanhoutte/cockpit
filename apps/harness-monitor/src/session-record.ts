/**
 * What a pull request body's session record says of its local reviews. The block
 * is written by scripts/lib/session-record.mjs (the format's owner); this worker
 * shares no code with the repository, so it reads just the review lines.
 */

const START = '<!-- session-record:start -->';
const END = '<!-- session-record:end -->';

export interface ReviewCounts {
  /** Local review rounds: the record's `review-start` marks. Null where the body has no record. */
  rounds: number | null;
  /** Findings the rounds reported: the sum of the `review-end` counts, null unless every review carries one. */
  findings: number | null;
}

const UNKNOWN: ReviewCounts = { rounds: null, findings: null };

/** A review's end carries its count on the level, as `<level>:<count>`; a line without one has an unknown count. */
const MARK = /^- \S+ (review-start|review-end) \S+ \S+?(?::(\d+))?$/;

export function reviewCounts(body: string | null | undefined): ReviewCounts {
  if (!body) return UNKNOWN;
  const start = body.indexOf(START);
  const end = body.indexOf(END);
  // Half a block, or two, is not telling what the record says.
  if (start === -1 || end < start || body.indexOf(START, start + 1) !== -1 || body.indexOf(END, end + 1) !== -1) return UNKNOWN;
  let rounds = 0;
  let ends = 0;
  let findings = 0;
  let counted = true;
  for (const line of body.slice(start, end).split(/\r?\n/)) {
    const mark = MARK.exec(line);
    if (!mark) continue;
    if (mark[1] === 'review-start') rounds += 1;
    else {
      ends += 1;
      if (mark[2] === undefined) counted = false;
      else findings += Number(mark[2]);
    }
  }
  // Every review needs an end with a count: a start with none yet, or none ever, leaves the total unknown.
  return { rounds, findings: rounds > 0 && ends >= rounds && counted ? findings : null };
}
