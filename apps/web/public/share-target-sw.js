/*
 * Receives what Android's share sheet posts to the installed app ("Share
 * photos, files and links into Cockpit from Android's share sheet", issue 789).
 *
 * A classic script, loaded into the generated service worker by `importScripts`
 * (vite.config.ts) so the update lifecycle stays the plugin's own. It cannot
 * import anything, so it is kept to what a share needs: keep the files, title,
 * text and link in a holding area on the device, then open Capture. Nothing
 * goes to the server here - a share is not a capture until Capture is pressed.
 *
 * The holding area is its own IndexedDB database, apart from the capture
 * outbox, read and emptied by the Capture page (src/shares.ts). The two agree
 * on the database, the store and the shape of a held share, and the addresses
 * below are checked against packages/shared/src/domain/share.ts by
 * tests/unit/shareTarget.test.ts.
 */
(function (root) {
  var SHARE_PATH = '/share-target';
  var CAPTURE_ADDRESS = '/capture';
  var FAILED_ADDRESS = '/capture?share=failed';
  var DATABASE = 'cockpit-shares';
  var STORE = 'held';
  // Copies of the Attachment rules (packages/shared/src/domain/attachment.ts),
  // which this script cannot import; tests/unit/shareTarget.test.ts holds them.
  var ALLOWED_TYPES = [
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'video/mp4',
    'video/webm',
    'video/quicktime',
    'application/pdf',
  ];
  var MAX_FILE_SIZE = 25 * 1024 * 1024;
  // What the holding area keeps in all: a share past it is refused, visibly,
  // rather than filling the device with what nobody has claimed.
  var MAX_HELD_BYTES = 4 * MAX_FILE_SIZE;
  // What one share may carry besides its files' bytes: a handful of files, and
  // words and names cut to a length no share sheet reaches.
  var MAX_FILES = 20;
  var MAX_WORDS = 4096;
  var MAX_NAME = 255;
  // Beside each share, its size, so the cap is a sum of numbers rather than a
  // read of every file held. The page claims by reading everything and skips them.
  var SIZE_KEY = 'size:';

  var said = function (value) {
    return typeof value === 'string' ? value.trim().slice(0, MAX_WORDS) : '';
  };

  /**
   * What a share form adds up to, or null where nothing in it is usable: no
   * file with any bytes and no title, text or link. A form with no file picked
   * still carries one empty file entry.
   */
  function shareFrom(form, id, receivedAt) {
    var files = form.getAll('files').filter(function (value) {
      return typeof value !== 'string' && value.size > 0;
    });
    var title = said(form.getAll('title')[0]);
    var text = said(form.getAll('text')[0]);
    var url = said(form.getAll('url')[0]);
    if (files.length === 0 && !title && !text && !url) return Promise.resolve(null);
    if (files.length > MAX_FILES) return Promise.reject(new Error('too many files'));
    return Promise.all(
      files.map(function (file) {
        // A file Attachments refuse keeps its name, type and size and no bytes:
        // the page says why it was refused, and nothing of it is stored.
        if (file.size > MAX_FILE_SIZE || ALLOWED_TYPES.indexOf(file.type) < 0) {
          return { name: nameOf(file), type: file.type, size: file.size, bytes: null };
        }
        return file.arrayBuffer().then(function (bytes) {
          return { name: nameOf(file), type: file.type, size: file.size, bytes: bytes };
        });
      }),
    ).then(function (kept) {
      return { id: id, receivedAt: receivedAt, title: title, text: text, url: url, files: kept };
    });
  }

  var nameOf = function (file) {
    return String(file.name).slice(0, MAX_NAME);
  };

  /** What a share takes up: its files' bytes and every word and name it carries. */
  var sizeOf = function (share) {
    return share.files.reduce(
      function (sum, file) {
        return sum + file.name.length + (file.bytes ? file.bytes.byteLength : 0);
      },
      share.title.length + share.text.length + share.url.length,
    );
  };

  /**
   * Keeps what was shared and says which address to open: Capture, or Capture
   * carrying the signal that nothing could be kept. `store.put` is the edge, the
   * browser's IndexedDB in the worker and a stand-in in a test; it refuses a
   * share that would take what waits past the limit it is given.
   */
  function receive(form, store, id, receivedAt) {
    return shareFrom(form, id, receivedAt)
      .then(function (share) {
        if (!share) return undefined;
        share.size = sizeOf(share);
        return store.put(share, MAX_HELD_BYTES);
      })
      .then(
        function () {
          return CAPTURE_ADDRESS;
        },
        function () {
          return FAILED_ADDRESS;
        },
      );
  }

  /**
   * Whether a share came from a page of another origin. A share-sheet launch
   * carries no referrer; a form on another site names its page. A form that
   * sends none is not caught, which is a risk accepted: what it puts on the note
   * is seen before Capture is pressed.
   */
  function fromAnotherSite(referrer, origin) {
    if (!referrer || referrer === 'about:client') return false;
    try {
      return new URL(referrer).origin !== origin;
    } catch (_) {
      return true;
    }
  }

  /** Whether a request is a share posted to this app: the method, this origin and the share address. */
  function isAShare(method, url, origin) {
    var address = new URL(url);
    return method === 'POST' && address.origin === origin && address.pathname === SHARE_PATH;
  }

  function opened() {
    return new Promise(function (resolve, reject) {
      var opening = root.indexedDB.open(DATABASE);
      opening.onupgradeneeded = function () {
        opening.result.createObjectStore(STORE);
      };
      opening.onsuccess = function () {
        resolve(opening.result);
      };
      opening.onerror = function () {
        reject(opening.error);
      };
    });
  }

  /** The browser's own, which fails the write where storage is refused or the limit would be passed. */
  var browserStore = {
    // One transaction: the sum of what waits and the write that depends on it.
    put: function (share, limit) {
      return opened().then(function (db) {
        return new Promise(function (resolve, reject) {
          var writing = db.transaction(STORE, 'readwrite');
          var held = writing.objectStore(STORE);
          var sizes = held.getAll(IDBKeyRange.bound(SIZE_KEY, SIZE_KEY + '\uffff'));
          sizes.onsuccess = function () {
            var total = sizes.result.reduce(function (sum, size) {
              return sum + size;
            }, share.size);
            if (total > limit) {
              writing.abort();
              return;
            }
            held.put(share, share.id);
            held.put(share.size, SIZE_KEY + share.id);
          };
          writing.oncomplete = function () {
            db.close();
            resolve();
          };
          writing.onabort = function () {
            db.close();
            reject(writing.error || new Error('full'));
          };
        });
      });
    },
  };

  root.cockpitShareTarget = {
    SHARE_PATH: SHARE_PATH,
    CAPTURE_ADDRESS: CAPTURE_ADDRESS,
    FAILED_ADDRESS: FAILED_ADDRESS,
    DATABASE: DATABASE,
    STORE: STORE,
    ALLOWED_TYPES: ALLOWED_TYPES,
    MAX_FILE_SIZE: MAX_FILE_SIZE,
    receive: receive,
    isAShare: isAShare,
    fromAnotherSite: fromAnotherSite,
    browserStore: browserStore,
    MAX_FILES: MAX_FILES,
    MAX_WORDS: MAX_WORDS,
    MAX_NAME: MAX_NAME,
  };

  // Only inside a service worker: loaded anywhere else, it just offers the above.
  if (typeof ServiceWorkerGlobalScope !== 'undefined' && root instanceof ServiceWorkerGlobalScope) {
    root.addEventListener('fetch', function (event) {
      var request = event.request;
      if (!isAShare(request.method, request.url, root.location.origin)) return;
      if (fromAnotherSite(request.referrer, root.location.origin)) {
        event.respondWith(Response.redirect(new URL(FAILED_ADDRESS, request.url).href, 303));
        return;
      }
      event.respondWith(
        request
          .formData()
          .then(function (form) {
            return receive(form, browserStore, root.crypto.randomUUID(), new Date().toISOString());
          })
          .catch(function () {
            return FAILED_ADDRESS;
          })
          .then(function (address) {
            return Response.redirect(new URL(address, request.url).href, 303);
          }),
      );
    });
  }
})(globalThis);
