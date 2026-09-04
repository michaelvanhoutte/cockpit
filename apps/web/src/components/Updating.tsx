import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  outOfDate,
  pickUpTheNewVersion,
  working,
  type Update,
  type Versions,
} from '../updating';

interface Props {
  children: React.ReactNode;
  /** F1 seam: the two facts about the browser that a test cannot have. */
  versions?: Versions;
  /** F1 seam: where the one-reload guard is kept. */
  memory?: Storage;
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
 * **Noticed from the query cache rather than reported by a component.** Every
 * read in the app goes through it, so one subscription sees a mismatch
 * whichever screen provoked it, and a page added tomorrow is covered by having
 * done nothing. Asked of the cache's own state rather than of the notification
 * it arrives in, so this does not depend on the shape of a library's events.
 */
export function Updating({ children, versions, memory }: Props) {
  const queryClient = useQueryClient();
  const [gated, setGated] = useState(false);

  useEffect(() => {
    const cache = queryClient.getQueryCache();
    const look = () => {
      const reads = cache.getAll();
      // A read that worked proves this build is not the one that was behind,
      // which is what releases the one-reload guard for the next deployment.
      if (reads.some((read) => read.state.status === 'success')) working(memory);
      if (reads.some((read) => outOfDate(read.state.error))) setGated(true);
    };
    look();
    return cache.subscribe(look);
  }, [queryClient, memory]);

  if (!gated) return children;
  return <Gate versions={versions} memory={memory} />;
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
