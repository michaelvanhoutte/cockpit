import { SHARE_FAILED_ADDRESS } from '@cockpit/shared';

/**
 * The installed app's share address, for the share that reached the network
 * ("Share photos, files and links into Cockpit from Android's share sheet",
 * issue 789).
 *
 * **A share is normally taken by the service worker and never gets here.** It
 * does when the manifest has reached Android but the waiting service worker
 * has not activated yet. What was shared is not read - nothing reaches the
 * server before Capture is pressed - and the share is lost, so Capture opens
 * saying so. A visit by address, a GET, just opens Capture.
 *
 * In front of the sign-in gate, like the other doors in `worker.ts`: it reads
 * nothing of anybody's and only redirects.
 */
export function answerShare(request: Request): Response {
  const address = request.method === 'POST' ? SHARE_FAILED_ADDRESS : '/capture';
  return Response.redirect(new URL(address, request.url).href, 303);
}
