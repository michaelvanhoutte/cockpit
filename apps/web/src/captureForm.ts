import { lazy } from 'react';

/**
 * The Capture form, fetched behind the shell rather than in its first bundle:
 * the outbox that sends captures has to be there from the first paint
 * (`captureOutboxSender.tsx`), and keeping the form out is what keeps the shell
 * inside its budget (architecture, "Performance budgets"). It is fetched
 * straight after the shell paints (`pages/Layout.tsx`) and before the Capture
 * page is drawn (`router.tsx`), so pressing Capture or `C` finds it already
 * here rather than waiting on it.
 */
export const loadCaptureNote = () => import('./components/CaptureNote');

export const CaptureNote = lazy(() => loadCaptureNote().then((form) => ({ default: form.CaptureNote })));
