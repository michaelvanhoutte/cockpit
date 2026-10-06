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

/**
 * The Car view of the same page ("Capture by voice in the car", issue 730),
 * fetched the same way and for the same reason; the route asks for it before
 * the page is drawn, so switching to Car finds it already here.
 */
export const loadCarCapture = () => import('./components/CarCapture');

export const CarCapture = lazy(() => loadCarCapture().then((view) => ({ default: view.CarCapture })));

export const CaptureNote = lazy(() => loadCaptureNote().then((form) => ({ default: form.CaptureNote })));

/**
 * Both sides of the Capture page's switch and what was shared into Cockpit
 * ("Share photos, files and links into Cockpit from Android's share sheet",
 * issue 789), fetched the same way, so the first bundle carries none of it.
 */
export const loadCaptureForms = () => import('./components/CaptureForms');

export const CaptureForms = lazy(() => loadCaptureForms().then((forms) => ({ default: forms.CaptureForms })));
