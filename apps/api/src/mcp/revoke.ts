import type { Env } from '../env.js';

/**
 * Revokes every grant somebody has given an app, with every token made from
 * it - for somebody whose access is being taken away or who is being deleted
 * ("Connect Claude to Cockpit, and capture an item from it", issue 599).
 *
 * **This is what makes cutting somebody off final.** The register check on
 * every call and refresh (`grant.ts`) refuses while they are disabled, but
 * would give a grant back the moment access is restored; revoked here, an app
 * has to be allowed again by whoever holds the account then. That check stays
 * as the backstop for a revocation that did not finish.
 *
 * **Through the helpers `worker.ts` puts on `env`**, the library's own way of
 * handing them to code it does not route (`OAUTH_PROVIDER`), so that the
 * application - which `apps/web` compiles for its contract - never imports
 * the library itself.
 *
 * **Never throws.** Taking somebody's access away, or deleting them, must not
 * fail because the apps they connected could not be reached: the refusal is
 * logged, and the register check refuses those grants regardless.
 */
export async function revokeAppsOf(env: Env, userId: string): Promise<void> {
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (!oauth) throw new Error('no OAuth helpers were put on env');
    let cursor: string | undefined;
    do {
      const page = await oauth.listUserGrants(userId, cursor ? { cursor } : {});
      await Promise.all(page.items.map((grant) => oauth.revokeGrant(grant.id, userId)));
      cursor = page.cursor;
    } while (cursor);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: `the apps ${userId} connected were not revoked; the register still refuses them`,
        cause: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
