import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { DEFAULT_WORKSPACE_THEME } from '@cockpit/shared';
import { signIn } from '../api/client';
import { usersQuery } from '../api/queries';
import { LoadFailure } from '../components/LoadFailure';
import { forgetEverything } from '../session/forget';

/**
 * The logon page: the people who use this Cockpit, and you say which one you
 * are.
 *
 * **A passwordless list of names is an identity selector, not an
 * authentication control**, and it is worth reading that here rather than only
 * in the architecture document, because this screen is the thing that would be
 * mistaken for one. Everything behind it is real - a real session, a real
 * cookie, a real gate on every request - so when Google sign-in arrives it
 * replaces this screen and nothing else. Until then Cloudflare Access stays in
 * front of every deployed environment.
 *
 * It paints in the default theme rather than in a workspace's: there is no
 * workspace yet, and there must not be one, because the whole point of this
 * screen is that nothing of the last person is still on it.
 */
export function LogonPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: users, error, isPending, refetch } = useQuery(usersQuery);

  /**
   * Arriving here means a visit is over, so this is where the browser is
   * emptied of it - whether the person signed out or the sign-in simply ran
   * out.
   *
   * **It is on this page rather than at either of the two places that send you
   * here**, and that is the fix for a leak found by driving the app: emptying
   * the cache while the app shell is still mounted does not work, because the
   * shell's own queries are observed, and React Query re-creates a removed
   * query the moment an observer that wants it renders. The stored copy was
   * therefore written straight back out, and a workspace of the last person's
   * survived in IndexedDB for the next one to paint from. Here nothing of the
   * app is mounted at all, so there is nothing to put it back.
   */
  useEffect(() => {
    void forgetEverything(queryClient);
  }, [queryClient]);

  const choose = useMutation({
    mutationFn: (userId: string) => signIn(userId),
    onSuccess: () => navigate({ to: '/' }),
  });

  return (
    <div
      className="flex min-h-dvh flex-col items-center justify-center px-4"
      style={{ backgroundColor: DEFAULT_WORKSPACE_THEME.ground }}
    >
      <main className="w-full max-w-sm rounded-lg bg-surface p-6 shadow-panel">
        <h1 className="text-xl font-semibold tracking-tight">Cockpit</h1>
        <p className="mt-1 text-sm text-ink-soft">Choose who you are.</p>

        {error ? (
          <div className="mt-4">
            <LoadFailure error={error} onRetry={() => void refetch()} />
          </div>
        ) : (
          <ul className="mt-4 flex flex-col gap-2">
            {users?.map((user) => (
              <li key={user.id}>
                <button
                  type="button"
                  disabled={choose.isPending}
                  onClick={() => choose.mutate(user.id)}
                  className="w-full rounded-md border border-accent-soft/70 bg-accent-tint px-3 py-2 text-left text-sm font-medium text-accent-deep hover:border-accent hover:bg-accent hover:text-white disabled:opacity-60"
                >
                  {user.name}
                </button>
              </li>
            ))}
          </ul>
        )}

        {isPending && !error && <p className="mt-4 text-sm text-ink-faint">Looking who is here…</p>}

        {/* What went wrong is deliberately not repeated: the only ways this
            fails are a name that has stopped existing since the list was read
            and a connection that is not there, and neither is something the
            person can act on beyond trying again. The mutation's own error
            state says it happened; nothing here has to remember it. */}
        {choose.isError && (
          <p role="alert" className="mt-4 text-sm text-ink-soft">
            That did not work. Try again, or pick another name.
          </p>
        )}
      </main>
    </div>
  );
}
