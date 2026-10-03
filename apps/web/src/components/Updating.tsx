import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  RECONNECTED,
  checkOnOpening,
  continueToNewVersion,
  outOfDate,
  pickUpTheNewVersion,
  realWorkers,
  type Update,
  type Versions,
  type Workers,
} from '../updating';

interface Props {
  children: React.ReactNode;
  /** F1 seam: the two facts about the browser that a test cannot have. */
  versions?: Versions;
  /** F1 seam: where the one-reload guard is kept. */
  memory?: Storage;
  /** F1 seam: the service worker, which a test cannot have. */
  workers?: Workers;
}

/**
 * The gate that holds the window while Cockpit picks up a new version of
 * itself (src/updating.ts, which carries the reasoning).
 *
 * **Around the whole app rather than inside the shell**, for the same reason
 * the undo bar is: the condition belongs to the window and not to a page. It
 * also means no screen has to remember to handle it — including the ones not
 * written yet, and including the logon page, which is outside the shell
 * entirely.
 *
 * **Noticed from the caches rather than reported by a component.** Every read
 * and every change in the app goes through one of them, so two subscriptions
 * see a mismatch whichever screen provoked it, and a page added tomorrow is
 * covered by having done nothing. Asked of each cache's own state rather than
 * of the notification it arrives in, so this does not depend on the shape of a
 * library's events.
 */
export function Updating({ children, versions, memory, workers = realWorkers }: Props) {
  const queryClient = useQueryClient();
  const [gated, setGated] = useState(false);
  const { opening, message } = useNewVersionKnown(workers);

  useEffect(() => {
    const reads = queryClient.getQueryCache();
    // Changes as well as reads, because a build behind the server is behind it
    // whichever kind of request finds out first - and a change is how several
    // screens learn anything at all. Watching only reads left a build that
    // *wrote* to an address the server had retired showing the refusal rather
    // than taking the new version ("Update instead of failing when a build asks
    // for an address that has been retired", issue 217).
    const changes = queryClient.getMutationCache();
    const look = () => {
      const behind =
        reads.getAll().some((read) => outOfDate(read.state.error)) ||
        changes.getAll().some((change) => outOfDate(change.state.error));
      if (behind) setGated(true);
    };
    look();
    const stopWatchingReads = reads.subscribe(look);
    const stopWatchingChanges = changes.subscribe(look);
    return () => {
      stopWatchingReads();
      stopWatchingChanges();
    };
  }, [queryClient, memory]);

  if (gated) return <Gate versions={versions} memory={memory} />;
  // Nothing of the old version is shown while the opening check is out, and
  // when it comes back as new the app is never mounted at all.
  if (opening === 'checking') return <div className="h-dvh bg-ground" aria-busy="true" />;
  if (opening === 'new') {
    return <NewVersion covering workers={workers} versions={versions} memory={memory} />;
  }
  return (
    <>
      {children}
      {message && <NewVersion workers={workers} versions={versions} memory={memory} />}
    </>
  );
}

/**
 * Split out so that mounting it *is* the attempt: the update runs once, on the
 * gate appearing, rather than on every render of an app that is still fine.
 */
function Gate({
  versions,
  memory,
}: {
  versions: Versions | undefined;
  memory: Storage | undefined;
}) {
  const [outcome, setOutcome] = useState<Update | null>(null);

  useEffect(() => {
    let current = true;
    void pickUpTheNewVersion(versions, memory).then((what) => {
      // 'taken' is only ever seen for the instant before the page goes; it is
      // set anyway rather than left null, so the words on screen are never a
      // question that has in fact been answered.
      if (current) setOutcome(what);
    });
    return () => {
      current = false;
    };
  }, [versions, memory]);

  const nothingNew = outcome === 'nothing-new';

  return (
    <div className="flex h-dvh items-center justify-center bg-ground p-6">
      <div
        role={nothingNew ? 'alert' : 'status'}
        className="max-w-sm rounded-lg bg-surface p-4 shadow-panel"
      >
        {nothingNew ? (
          <>
            <h2 className="text-base font-semibold text-over">{"Cockpit couldn't update"}</h2>
            <p className="mt-1 text-sm text-ink-soft">
              The version being served is older than the data it reads, and there is nothing newer
              to fetch. It has to be rebuilt or redeployed.
            </p>
          </>
        ) : (
          <>
            {/* `text-ink`, not the `text-over` the failure screen uses: this is
                the app doing what it should, not something going wrong. */}
            <h2 className="text-base font-semibold text-ink">Updating Cockpit</h2>
            <p className="mt-1 text-sm text-ink-soft">
              A newer version is out. Fetching it, then picking up where you were.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Whether a newer version is known, from opening and from the triggers after
 * it (updating.ts, `checkOnOpening`). Held in one place so two triggers close
 * together are one message: `message` is a flag, and a check already in flight
 * is reused rather than started again.
 *
 * The triggers are the tab coming back into view and the live-updates stream
 * coming up again after a drop; a tab nobody is looking at asks nothing. The
 * worker serving the page changing under it (another tab's click) is the same
 * message, held until this tab's own click.
 */
function useNewVersionKnown(workers: Workers) {
  const [opening, setOpening] = useState<'checking' | 'new' | 'open'>(() =>
    workers.supported() ? 'checking' : 'open',
  );
  const [message, setMessage] = useState(false);
  useEffect(() => {
    // Setting state after unmount is a no-op, so nothing here tracks being alive.
    void checkOnOpening(workers).then(({ now, later }) => {
      setOpening((was) => (was === 'checking' ? now : was));
      void later.then((isNew) => isNew && setMessage(true));
    });
  }, [workers]);

  useEffect(() => {
    if (!workers.supported()) return;
    let looking = false;
    const look = () => {
      if (looking) return;
      looking = true;
      workers
        .check()
        .then(
          (isNew) => isNew && setMessage(true),
          // Cannot be answered: the old version stays and the next trigger asks again.
          () => undefined,
        )
        .finally(() => {
          looking = false;
        });
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') look();
    };
    document.addEventListener('visibilitychange', onVisibility);
    globalThis.addEventListener(RECONNECTED, look);
    const stopTakenOver = workers.onTakenOver(() => setMessage(true));
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      globalThis.removeEventListener(RECONNECTED, look);
      stopTakenOver();
    };
  }, [workers]);

  return { opening, message };
}

/**
 * The message that a newer version is out, and the one click that loads it.
 *
 * **Over the app and not instead of it** once the app is open, so what is on
 * a form stays on screen and can still be saved before the click: the scrim
 * dims but passes pointer events through, and only the card takes them. At
 * opening nothing is mounted behind it (`covering`), so there is nothing to
 * lose. The click is the only thing that activates the new worker.
 */
function NewVersion({
  covering = false,
  workers,
  versions,
  memory,
}: {
  covering?: boolean;
  workers: Workers;
  versions: Versions | undefined;
  memory: Storage | undefined;
}) {
  const [loading, setLoading] = useState(false);
  const card = (
    <div role="alertdialog" aria-labelledby="new-version-title" className="pointer-events-auto max-w-sm rounded-lg bg-surface p-4 shadow-panel">
      <h2 id="new-version-title" className="text-base font-semibold text-ink">
        A new version of Cockpit is out
      </h2>
      <p className="mt-1 text-sm text-ink-soft">
        {covering
          ? 'Continue to load it.'
          : 'Save what you are writing, then continue to load it. Nothing on screen is lost until you do.'}
      </p>
      <button
        type="button"
        disabled={loading}
        className="mt-3 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
        onClick={() => {
          // One click, one reload: a second press while the first is in flight
          // is ignored rather than started again.
          if (loading) return;
          setLoading(true);
          void continueToNewVersion(workers, versions, memory);
        }}
      >
        Continue
      </button>
    </div>
  );
  if (covering) {
    return <div className="flex h-dvh items-center justify-center bg-ground p-6">{card}</div>;
  }
  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex items-end justify-center bg-ground/60 p-4">
      {card}
    </div>
  );
}
