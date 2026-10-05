import { Component, lazy, useState, type ReactNode } from 'react';
import { takeTheNewVersion } from '../updating';

/**
 * The editor, reached the one way anything outside its own chunk may reach it:
 * through `React.lazy`, with the three pieces every caller needs beside it - the
 * boundary that catches a failure, the mark that tells a failed download from a
 * failed render, and the offer of a newer version. `DescriptionBox` and
 * `CaptureNote` share them, so the two say the same thing about the same failure.
 */
export const LazyRichDescription = lazy(() => import('../description/RichDescription').catch(neverArrived));

/**
 * That the editor's file itself did not arrive, as against having arrived and
 * thrown while rendering.
 *
 * **Marked here because this is the only place that can tell them apart.** The
 * boundary below catches both and sees the same thing from each, and they are
 * not the same thing at all: a fetch that failed may say this build has been
 * replaced under the tab (`updating.ts`, `takeTheNewVersion`), where a
 * component that threw as it drew is a bug, and offering a new version for it
 * would be offering a cure for the wrong illness.
 *
 * **It divides the fetch from the drawing, and not quite failure from bug.** An
 * editor that threw while being *evaluated* rejects the same fetch and is
 * marked with the rest, which is a line drawn where it can be drawn rather than
 * where one would want it. Harmless, because nothing here decides on the mark
 * alone: `takeTheNewVersion` goes and asks what is being served, finds this
 * same version, and declines.
 *
 * A module-level flag rather than state, because the fetch belongs to the
 * module and not to whichever box is on screen: `lazy` remembers its first
 * answer, so the second form opened after a failure never asks again and would
 * otherwise have nothing to read.
 */
let theEditorNeverArrived = false;

function neverArrived(notThere: unknown): never {
  theEditorNeverArrived = true;
  throw notThere;
}

/** What is said where asking changed nothing. Never said before asking. */
const ANSWER = {
  'nothing-new': 'This is already the newest version of Cockpit.',
  'could-not-ask': 'Cockpit could not check for a new version.',
} as const;

/**
 * The way out of a formatting bar that will never arrive: take the version this
 * one's file belongs to (`updating.ts`, `takeTheNewVersion`).
 *
 * **Both of the ways it can decline are said out loud, and they are not the
 * same thing.** A file goes missing for dull reasons too - a connection that
 * dropped, a proxy that ate the request - and the difference between *there is
 * nothing newer* and *I could not find out* is the difference between having
 * checked and having failed to. Saying the first for the second would be
 * telling somebody they are up to date on the strength of a question nobody
 * answered.
 */
function NewerVersion() {
  const [answer, setAnswer] = useState<keyof typeof ANSWER | null>(null);
  const [asking, setAsking] = useState(false);

  if (answer) return <>{ANSWER[answer]}</>;
  return (
    <button
      type="button"
      disabled={asking}
      onClick={() => {
        setAsking(true);
        void takeTheNewVersion().then((what) => {
          // 'taken' is only ever the instant before the page goes, and is
          // deliberately left saying nothing: a message that flashed up and
          // vanished would be one nobody could read anyway.
          if (what !== 'taken') setAnswer(what);
          setAsking(false);
        });
      }}
      className="underline underline-offset-2 hover:no-underline disabled:no-underline disabled:opacity-60"
    >
      Get the new version
    </button>
  );
}

/** The offer of a newer version, drawn only where the editor's file is what failed to arrive. */
export function NewerVersionIfStale() {
  return theEditorNeverArrived ? <NewerVersion /> : null;
}

/**
 * What happens when the chunk does not arrive - an offline cold open, a deploy
 * that moved the file out from under a stale service worker. Without this the
 * whole form goes down with it and the description is unreachable, which is the
 * one thing the split was not allowed to cost.
 *
 * A class, because a boundary is still the only thing in React that can catch a
 * render failure.
 */
export class WhateverTheEditorDoes extends Component<
  { children: ReactNode; onFailure: () => void },
  { broken: boolean }
> {
  state = { broken: false };

  static getDerivedStateFromError() {
    return { broken: true };
  }

  componentDidCatch() {
    this.props.onFailure();
  }

  render() {
    return this.state.broken ? null : this.props.children;
  }
}
