import { FIRST_WORKSPACE_NAME } from '@cockpit/shared';
import { browserStore } from './lastVisited';

/**
 * Whether an account is one nobody has started on, and so whether the app
 * opens on the question that names its workspace (`pages/WelcomePage.tsx`).
 *
 * **The decision is a function of the list and one remembered fact**, with the
 * storage handed in rather than reached for - the same shape `lastVisited.ts`
 * takes, and for the same reason: it makes the deciding provable without a
 * browser, and a browser that refuses storage answers the question rather than
 * throwing it.
 *
 * **Being through it is remembered in the browser, not on the account.** It is
 * a thing this person on this device has seen, like the view a workspace opens
 * on, and storing it on the account would mean a write, an invalidation and a
 * push for something no other device benefits from. What it costs is that a
 * phone asks again; what it buys is no column, no command and no round trip.
 */
const KEY = 'cockpit.welcomed';

/**
 * An untouched account: one workspace, still wearing the name it was given
 * (apps/api/src/accounts/changes.ts).
 *
 * **The name rather than a flag**, so nothing has to be stored to know it and
 * an account restored from a backup is exactly as far along as its rows say.
 * Renaming the workspace back would honestly bring the question back, which is
 * why the browser's memory is the other half: having been through it once is
 * what stops it.
 */
export function isUntouched(workspaces: readonly { name: string }[]): boolean {
  return workspaces.length === 1 && workspaces[0]!.name === FIRST_WORKSPACE_NAME;
}

/** Whether to open on the question, given the account and what the browser remembers. */
export function shouldWelcome(
  workspaces: readonly { name: string }[],
  welcomedBefore: boolean,
): boolean {
  return !welcomedBefore && isUntouched(workspaces);
}

/** Whether this browser has been through the question, however it left. */
export function welcomedBefore(): boolean {
  return Boolean(browserStore()?.getItem(KEY));
}

/**
 * Remembers that it has, which both answers do: naming the workspace and
 * walking past it are the same amount of "I have seen this".
 */
export function rememberWelcomed(): void {
  try {
    browserStore()?.setItem(KEY, 'yes');
  } catch {
    // A browser that refuses storage asks again, which is the honest outcome
    // rather than a reason to fail on the way into the app.
  }
}
