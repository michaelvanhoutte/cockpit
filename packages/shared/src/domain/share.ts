/**
 * Sharing into Cockpit from the phone's share sheet ("Share photos, files and
 * links into Cockpit from Android's share sheet", issue 789): the addresses the
 * manifest, the service worker and the Worker agree on.
 */

/** Where the installed app's share target posts what was shared. */
export const SHARE_TARGET_PATH = '/share-target';

/** Capture, opened with the signal that what was shared could not be kept. */
export const SHARE_FAILED_ADDRESS = '/capture?share=failed';

/** What Capture says when it is opened with that signal. */
export const SHARE_FAILED_MESSAGE =
  "Couldn't receive what you shared — update Cockpit and share again.";
