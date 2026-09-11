import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { DEFAULT_WORKSPACE_THEME } from '@cockpit/shared';
import { GUEST_SIGN_IN_PATH, SIGN_IN_PATH } from '../api/client';
import { forgetEverything } from '../session/forget';

/**
 * The logon page: your Google account, or - where the deployment offers it -
 * the shared guest account ("Sign in as a guest, without a password", issue
 * 354).
 *
 * **It reads nothing.** The list of names it used to show was the one read that
 * answered before anybody had signed in, and it went with the picker ("Sign in
 * with Google, and retire the list of names", issue 196) - publishing who has an
 * account here buys nothing once it is no longer the way in. So there is no
 * loading state, no failure to recover from, and nothing on this page that
 * belongs to anybody.
 *
 * That is also why both controls are drawn everywhere: one build is served by
 * every deployment, and a page that reads nothing has nothing to ask about the
 * one it is running on. Pressing the guest control where guest sign-in is not
 * offered comes back refused, like any other sign-in that will not complete.
 *
 * It paints in the default theme rather than in a workspace's: there is no
 * workspace yet, and there must not be one, because the whole point of this
 * screen is that nothing of the last person is still on it.
 */
export function LogonPage() {
  const queryClient = useQueryClient();

  /**
   * Arriving here means a visit is over, so this is where the browser is
   * emptied of it - whether the person signed out, the sign-in ran out, or a
   * sign-in was refused.
   *
   * **It is on this page rather than at any of the places that send you here**,
   * and that is the fix for a leak found by driving the app: emptying the cache
   * while the app shell is still mounted does not work, because the shell's own
   * queries are observed, and React Query re-creates a removed query the moment
   * an observer that wants it renders. The stored copy was therefore written
   * straight back out, and a workspace of the last person's survived in
   * IndexedDB for the next one to paint from. Here nothing of the app is
   * mounted at all, so there is nothing to put it back.
   */
  useEffect(() => {
    void forgetEverything(queryClient);
  }, [queryClient]);

  return (
    <div
      className="flex min-h-dvh flex-col items-center justify-center px-4"
      style={{ backgroundColor: DEFAULT_WORKSPACE_THEME.ground }}
    >
      <main className="w-full max-w-sm rounded-lg bg-surface p-6 shadow-panel">
        <h1 className="text-xl font-semibold tracking-tight">Cockpit</h1>
        <p className="mt-1 text-sm text-ink-soft">Sign in to pick up where you left off.</p>

        {/* A link rather than a button that navigates: signing in *is* a
            navigation - the browser leaves for Google and comes back - so the
            control that starts it is the one the browser already knows how to
            follow, working with a middle click and without JavaScript having to
            run first. */}
        <a
          href={SIGN_IN_PATH}
          className="mt-4 flex w-full items-center justify-center rounded-md border border-accent-soft/70 bg-accent-tint px-3 py-2 text-sm font-medium text-accent-deep hover:border-accent hover:bg-accent hover:text-white"
        >
          Continue with Google
        </a>

        {/* A link for the same reason as the one above, though this journey
            never leaves Cockpit: it ends in a page rather than in an answer to
            parse, so there is nothing here to await. */}
        <a
          href={GUEST_SIGN_IN_PATH}
          className="mt-2 flex w-full items-center justify-center rounded-md border border-black/10 px-3 py-2 text-sm font-medium text-ink-soft hover:bg-accent-tint hover:text-accent-deep"
        >
          Continue as guest
        </a>

        <Refusal />
      </main>
    </div>
  );
}

/**
 * Why the last attempt did not work, when it did not.
 *
 * Three messages and no more, because there are three things a person can do
 * about it: use a different Google account, ask an admin for their access back,
 * or try again. Every other way a sign-in fails - a reply that belongs to
 * nobody, an identity that will not verify - is something an attacker got wrong
 * rather than something the person in front of the screen did, and those go to
 * the log with nothing said here beyond that it failed.
 *
 * **Access removed is said rather than folded into the unknown-account
 * sentence** ("Take somebody's access away without taking their work", issue
 * 233). It tells anyone trying the address that this Cockpit holds it, which is
 * a disclosure taken knowingly: the person it actually happens to is a
 * colleague who would otherwise be told, wrongly, that they have no account
 * here and sent looking for a sign-in problem that is not theirs.
 *
 * Read straight off the address rather than through the router, because the
 * Worker is what put it there: this page is where a redirect lands, not
 * somewhere the application navigated with state in hand.
 */
function Refusal() {
  const refused = new URLSearchParams(window.location.search).get('refused');
  if (!refused) return null;

  return (
    <p role="alert" className="mt-4 text-sm text-ink-soft">
      {refused === 'unknown-account'
        ? 'That Google account is not one this Cockpit knows. Try another, or ask for one to be added.'
        : refused === 'access-removed'
          ? 'Your access to this Cockpit was removed. Everything you had is still here; ask an admin to give it back.'
          : 'That did not work. Try signing in again.'}
    </p>
  );
}
