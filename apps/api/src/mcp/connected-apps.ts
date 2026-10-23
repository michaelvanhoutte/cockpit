import type { ConnectedApp } from '@cockpit/shared';
import { SIGN_IN_LIFETIME_MS } from '../auth/session.js';
import type { Env } from '../env.js';
import { kindOfScope } from './scope.js';

/**
 * The apps somebody has allowed, and cutting one off ("See the apps connected
 * to your Cockpit, and disconnect one", issue 600).
 *
 * **Through the helpers `worker.ts` puts on `env`**, as `revoke.ts` does, so
 * that nothing `apps/web` compiles imports the OAuth library.
 *
 * **Only ever the signed-in person's own.** The library keys a grant by the
 * person who made it, so listing is by their id, and disconnecting looks the
 * id up in that list first: an id from somebody else's grant is nothing here
 * rather than a revocation of it.
 */

/** How long a grant lasts without being used again: as long as a sign-in does. */
export const GRANT_LIFETIME_S = Math.floor(SIGN_IN_LIFETIME_MS / 1000);

/** Where an app's last capture is kept, beside the library's own keys and apart from them. */
const lastCaptureKey = (grantId: string) => `cockpit:last-capture:${grantId}`;

/** The same, for the last time an app read a Panel (issue 1445). */
const lastReadKey = (grantId: string) => `cockpit:last-read:${grantId}`;

/**
 * How long a noted read stands before the next one is noted again. A widget
 * reads every half hour, a Panel each time, and every note is a write to a
 * namespace whose daily allowance is shared with signing in (`docs/deployment.md`):
 * a note that is at most ten minutes old says *last read* as truly as a fresh one
 * does, at the minute the list is drawn to.
 */
const NOTE_A_READ_EVERY_MS = 10 * 60_000;

/** Whether a read at `at` is to be noted, given the time noted last, if one is: none noted, or the one noted has stood ten minutes. */
export function readNeedsNoting(lastNoted: string | null, at: string): boolean {
  const last = Date.parse(lastNoted ?? '');
  return !Number.isFinite(last) || Date.parse(at) - last >= NOTE_A_READ_EVERY_MS;
}

/**
 * Notes that the grant just captured something. Kept in the namespace the
 * grant itself lives in rather than in the account: it is as ephemeral as the
 * grant - revoking the grant leaves it to lapse - and no account's work.
 *
 * **Never throws**: the Item is written by the time this is called, and an app
 * told the capture failed would capture it twice.
 */
export async function noteCapture(env: Env, grantId: string, at: string): Promise<void> {
  try {
    await env.OAUTH_KV.put(lastCaptureKey(grantId), at, { expirationTtl: GRANT_LIFETIME_S });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'the time an app last captured was not kept',
        cause: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/**
 * Notes that the grant just read a Panel (issue 1445), unless it was noted
 * within the last ten minutes. Kept where the capture's is, for the same
 * reason, and **never throws**: the read is answered by the time this is
 * called, and an app told it failed would only ask again.
 */
export async function noteRead(env: Env, grantId: string, at: string): Promise<void> {
  try {
    if (!readNeedsNoting(await env.OAUTH_KV.get(lastReadKey(grantId)), at)) return;
    await env.OAUTH_KV.put(lastReadKey(grantId), at, { expirationTtl: GRANT_LIFETIME_S });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'the time an app last read a Panel was not kept',
        cause: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/** Every app `userId` has allowed, oldest first. */
export async function connectedAppsOf(env: Env, userId: string): Promise<ConnectedApp[]> {
  const grants = await grantsOf(env, userId);
  const apps = await Promise.all(
    grants.map(async (grant): Promise<ConnectedApp> => {
      const kind = kindOfScope(grant.scope);
      const [captured, read] = await Promise.all([
        kind === 'captures' ? env.OAUTH_KV.get(lastCaptureKey(grant.id)) : null,
        kind === 'reads-panels' ? env.OAUTH_KV.get(lastReadKey(grant.id)) : null,
      ]);
      return {
        id: grant.id,
        name: nameOf(grant.metadata),
        kind,
        // The library counts in seconds.
        connectedAt: new Date(grant.createdAt * 1000).toISOString(),
        lastCapturedAt: asTime(captured),
        lastReadAt: asTime(read),
      };
    }),
  );
  return apps.sort((a, b) => a.connectedAt.localeCompare(b.connectedAt) || a.id.localeCompare(b.id));
}

/**
 * Ends one of `userId`'s apps' access at once - its access and refresh tokens
 * both, which the library deletes with the grant - or says `false` where
 * `userId` has no such grant. Throws where the library could not be reached,
 * which is the one answer that must not read as done.
 */
export async function disconnectApp(env: Env, userId: string, grantId: string): Promise<boolean> {
  const oauth = env.OAUTH_PROVIDER;
  if (!oauth) throw new Error('no OAuth helpers were put on env');
  if (!(await grantsOf(env, userId)).some((grant) => grant.id === grantId)) return false;
  await oauth.revokeGrant(grantId, userId);
  await Promise.all([
    env.OAUTH_KV.delete(lastCaptureKey(grantId)).catch(() => undefined),
    env.OAUTH_KV.delete(lastReadKey(grantId)).catch(() => undefined),
  ]);
  return true;
}

async function grantsOf(env: Env, userId: string) {
  const oauth = env.OAUTH_PROVIDER;
  if (!oauth) throw new Error('no OAuth helpers were put on env');
  const grants = [];
  let cursor: string | undefined;
  do {
    const page = await oauth.listUserGrants(userId, cursor ? { cursor } : {});
    grants.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return grants;
}

/** A noted time as the list says it, or null for none noted or one that does not read as a time. */
function asTime(noted: string | null): string | null {
  return noted && Number.isFinite(Date.parse(noted)) ? new Date(noted).toISOString() : null;
}

/** What the app registered itself as, which `consent.ts` put on the grant. */
function nameOf(metadata: unknown): string {
  const name = (metadata as { clientName?: unknown } | null | undefined)?.clientName;
  return typeof name === 'string' && name.trim() ? name : 'An app';
}
