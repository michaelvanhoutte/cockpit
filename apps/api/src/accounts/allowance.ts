/**
 * Whether an error is Cloudflare saying the free tier's daily allowance of
 * Durable Object rows is spent, rather than anything wrong with the data.
 *
 * It is told apart from any other failure because the two want opposite
 * responses: a change that will not apply is fixed in the code, a spent
 * allowance is fixed by waiting for 00:00 UTC or by Workers Paid, and calling
 * the second the first sends whoever reads it to the migrations.
 *
 * Matched on the message, because that is all an error crossing the storage
 * API carries: "Exceeded allowed rows read in Durable Objects free tier" and
 * its "rows written" twin.
 */
export function allowanceSpent(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /exceeded allowed rows (read|written) in durable objects/i.test(message);
}

/**
 * What an API request is told. It names the limit and no account: nobody names
 * an account on a request, and the answer is the same whichever account met it.
 */
export const ALLOWANCE_SPENT_MESSAGE =
  "the daily allowance of Durable Object reads and writes on Cloudflare's free tier is spent; it clears at 00:00 UTC, or on Workers Paid";
