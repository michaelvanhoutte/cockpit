import type { HeldShare } from '../../../src/shares';

/**
 * A share waiting in the fake IndexedDB, written the way the service worker's
 * script writes it (public/share-target-sw.js): its own database, one store,
 * the share's id as the key.
 */
export const aShare = (over: Partial<HeldShare> = {}): HeldShare => ({
  id: 'share-1',
  receivedAt: '2026-10-06T08:00:00.000Z',
  title: '',
  text: '',
  url: '',
  files: [],
  ...over,
});

export const aSharedPhoto = (name = 'photo.png') => ({
  name,
  type: 'image/png',
  bytes: new TextEncoder().encode('png').buffer as ArrayBuffer,
});

export function holdAShare(share: HeldShare): Promise<void> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open('cockpit-shares');
    opening.onupgradeneeded = () => opening.result.createObjectStore('held');
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const writing = opening.result.transaction('held', 'readwrite');
      writing.objectStore('held').put(share, share.id);
      writing.oncomplete = () => resolve();
      writing.onerror = () => reject(writing.error);
    };
  });
}

/** How many shares are waiting, which is none where the database was never made. */
export function howManyAreHeld(): Promise<number> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open('cockpit-shares');
    opening.onupgradeneeded = () => opening.result.createObjectStore('held');
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const counting = opening.result.transaction('held').objectStore('held').count();
      counting.onsuccess = () => resolve(counting.result);
      counting.onerror = () => reject(counting.error);
    };
  });
}
