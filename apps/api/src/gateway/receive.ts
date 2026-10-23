import { z } from 'zod';
import type { Env } from '../env.js';
import type { AttemptRecord, Trigger } from './attempts.js';
import { recordReceived } from './record.js';

/**
 * Where production takes the records another environment sends it ("Record
 * staging's and local Claude calls in production, under a token per
 * environment", issue 1458).
 *
 * **Outside the sign-in gate and outside the operator's secret**
 * (`auth/gate.ts`): whoever calls it is a Worker or a runner with no session,
 * and the operator's `BACKUP_TOKEN`, which reads every account's data, must not
 * be what opens it. What admits a call is a recording token, and each opens
 * this route and nothing else.
 */
export const USAGE_RECORDS_PATH = '/v1/usage-records';

/** The environments that send, and the production secret holding the token each sends under. */
const TOKENS = [
  ['staging', 'USAGE_TOKEN_STAGING'],
  ['ci', 'USAGE_TOKEN_CI'],
  ['local', 'USAGE_TOKEN_LOCAL'],
] as const satisfies readonly (readonly [string, keyof Env])[];

export type SendingEnvironment = (typeof TOKENS)[number][0];

const encoder = new TextEncoder();

export async function digest(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

/** Whether two digests are equal, looking at every byte whatever the first difference is. */
export function sameDigest(a: Uint8Array, b: Uint8Array): boolean {
  let difference = a.length ^ b.length;
  for (let i = 0; i < a.length; i += 1) difference |= a[i]! ^ (b[i] ?? 0);
  return difference === 0;
}

/**
 * Which environment's token a request carries, or `null` for none, one that is
 * not any of the three, or one that is set to more than one environment.
 *
 * **Compared in constant time and against all three, with no early exit**, as
 * digests of the same length so the offered token's length is not what the
 * comparison's time depends on. A token not configured here never matches, so
 * an environment holding none of them refuses everything.
 */
export async function environmentOfToken(
  env: Pick<Env, 'USAGE_TOKEN_STAGING' | 'USAGE_TOKEN_CI' | 'USAGE_TOKEN_LOCAL'>,
  authorization: string | undefined,
): Promise<SendingEnvironment | null> {
  const [scheme, ...rest] = (authorization ?? '').split(' ');
  const offered = rest.join(' ').trim();
  if (scheme?.toLowerCase() !== 'bearer' || !offered) return null;
  const offeredDigest = await digest(offered);
  const matches: SendingEnvironment[] = [];
  for (const [environment, secret] of TOKENS) {
    const held = env[secret];
    const same = sameDigest(offeredDigest, await digest(held || ' no token '));
    if (held && same) matches.push(environment);
  }
  return matches.length === 1 ? matches[0]! : null;
}

const count = z.number().int().min(0).nullable();

/**
 * One settled attempt as another environment sends it. **Strict, and with no
 * `environment` of its own**: which environment sent it is the token's to say,
 * never the body's. What the sender could not know, the cost, is production's
 * to work out.
 */
const sentRecordSchema = z
  .object({
    operation: z.string().min(1).max(100),
    promptVersion: z.string().max(100).nullable(),
    triggeredBy: z.string().max(100).nullable(),
    accountName: z.string().min(1).max(200),
    itemId: z.string().max(200).nullable(),
    provider: z.string().min(1).max(50),
    model: z.string().min(1).max(100),
    paidBy: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('cockpit-anthropic-key'),
        account: z.string().max(200).nullable(),
        keyEnding: z.string().max(8),
      }),
      z.object({ kind: z.literal('cloudflare-workers-ai'), account: z.null(), keyEnding: z.null() }),
      z.object({ kind: z.literal('claude-plan'), account: z.string().max(200), keyEnding: z.null() }),
    ]),
    outcome: z.enum(['ok', 'error', 'timed-out']),
    status: z.number().int().min(0).max(999).nullable().optional(),
    tokensIn: count,
    cacheRead: count,
    cacheWrite: count,
    tokensOut: count,
    at: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/)
      // A real instant on the day it names: `2026-02-31` and `T24:00:00` parse but
      // roll over, and the table's own check refuses them with a 500 if let in.
      .refine((at) => {
        const instant = Date.parse(at);
        return !Number.isNaN(instant) && new Date(instant).toISOString().slice(0, 10) === at.slice(0, 10);
      }),
    durationMs: z.number().min(0).max(86_400_000),
    /** The sender's own user id, which is never resolved against production's users. */
    userId: z.string().max(200).nullable(),
    /** The branch a local checkout was on. */
    branch: z.string().max(250).nullable().optional(),
    /** The pull request a CI contract run made the call for; none on a scheduled or by-hand run. */
    pullRequest: z.number().int().min(1).nullable().optional(),
    /** The GitHub Actions run a CI contract run made the call in. */
    runId: z.number().int().min(1).nullable().optional(),
  })
  .strict();

export type Received = { status: 201 } | { status: 400 | 401 | 403; error: string };

/**
 * Records what a sending environment sent, as that environment's.
 *
 * Refused, with nothing recorded, for no token or one that is none of the
 * three's (the same answer whichever, as the operator's gate gives), for a
 * record claiming to be production's, and for one that is not the shape of a
 * settled attempt.
 */
export async function receiveRecord(
  env: Env,
  authorization: string | undefined,
  readBody: () => Promise<unknown>,
): Promise<Received> {
  const environment = await environmentOfToken(env, authorization);
  if (!environment) return { status: 401, error: 'not allowed' };
  // Read only for a caller already let in, so a body nobody may send is never parsed.
  const body = await readBody().catch(() => null);

  if (typeof body === 'object' && body !== null && (body as { environment?: unknown }).environment === 'production') {
    return { status: 403, error: 'a record cannot claim to be production’s' };
  }
  const parsed = sentRecordSchema.safeParse(body);
  if (!parsed.success) {
    const problem = parsed.error.issues[0];
    return { status: 400, error: `that is not a record: ${problem?.path.join('.') || 'the body'} ${problem?.message ?? ''}`.trim() };
  }

  const { userId, branch, pullRequest, runId, status, ...sent } = parsed.data;
  // What started a call is open-ended (`connector:<id>`), so any text is a `Trigger`.
  const about = { ...sent, triggeredBy: sent.triggeredBy as Trigger | null };
  const row: AttemptRecord =
    about.outcome === 'error'
      ? { ...about, outcome: 'error', status: status ?? null }
      : { ...about, outcome: about.outcome };
  await recordReceived(env, row, environment, userId, {
    branch: branch ?? null,
    pullRequest: pullRequest ?? null,
    runId: runId ?? null,
  });
  return { status: 201 };
}
