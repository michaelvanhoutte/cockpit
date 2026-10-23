import type { PanelOpening } from './captureOpener';

/**
 * What the header's tab and `C` put in the navigation's state to say which
 * workspace they were pressed in. State rather than the address: the address is
 * what a link and the installed app's shortcut open, and those come from
 * outside a workspace. **An address that does name one - a widget's +, with
 * `?workspace=` and `&panel=` - is turned into this same state on the way in**
 * (`captureOpening.ts`, `router.tsx`), so the page knows one way in.
 */
export interface CaptureState {
  captureFrom?: string;
  /** The Panel a + on its header opened Capture for (issue 1105). */
  captureOn?: PanelOpening;
}

/**
 * The state to navigate to `/capture` with. Cast because the router types its
 * state as an interface only an augmentation of `@tanstack/history` can add
 * to, and that package is not this one's to import.
 */
export const captureStateFor = (workspaceId: string | undefined, on?: PanelOpening): never =>
  ({
    ...(workspaceId ? { captureFrom: workspaceId } : {}),
    ...(on ? { captureOn: on } : {}),
  }) as CaptureState as never;
