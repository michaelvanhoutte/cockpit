import { useSyncExternalStore } from 'react';
import { paintedWorkspace, shellColours, type Appearance } from '@cockpit/shared';

/** The flag on the document while the app is dark; `appearanceBoot.js` sets and clears it. */
export const DARK_FLAG = 'data-app-dark';

const root = () => document.documentElement;

function subscribe(onChange: () => void): () => void {
  const watching = new MutationObserver(onChange);
  watching.observe(root(), { attributes: true, attributeFilter: [DARK_FLAG] });
  return () => watching.disconnect();
}

/** The appearance the document is in now, and the shell's cue to compute its colours against it. */
export function useAppearance(): Appearance {
  const dark = useSyncExternalStore(subscribe, () => root().hasAttribute(DARK_FLAG));
  return dark ? 'dark' : 'light';
}

/** The page's colour where no Workspace is open (the logon page, the first Workspace's page): the default theme's, in whichever appearance. */
export function usePageGround(): string {
  return shellColours(paintedWorkspace(undefined), useAppearance()).ground;
}
