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

  var said = function (value) {
    return typeof value === 'string' ? value.trim() : '';
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
    return Promise.all(
      files.map(function (file) {
        // A file Attachments refuse keeps its name, type and size and no bytes:
        // the page says why it was refused, and nothing of it is stored.
        if (file.size > MAX_FILE_SIZE || ALLOWED_TYPES.indexOf(file.type) < 0) {
          return { name: file.name, type: file.type, size: file.size, bytes: null };
        }
        return file.arrayBuffer().then(function (bytes) {
          return { name: file.name, type: file.type, size: file.size, bytes: bytes };
        });
      }),
    ).then(function (kept) {
      return { id: id, receivedAt: receivedAt, title: title, text: text, url: url, files: kept };
    });
  }

  var bytesOf = function (share) {
    return share.files.reduce(function (sum, file) {
      return sum + (file.bytes ? file.bytes.byteLength : 0);
    }, 0);
  };

  /**
   * Keeps what was shared and says which address to open: Capture, or Capture
   * carrying the signal that nothing could be kept. `store` is the edge, the
   * browser's IndexedDB in the worker and a stand-in in a test: `put`, and
   * `bytesHeld` for the cap on what waits.
   */
  function receive(form, store, id, receivedAt) {
    return shareFrom(form, id, receivedAt)
      .then(function (share) {
        if (!share) return undefined;
        return store.bytesHeld().then(function (held) {
          if (held + bytesOf(share) > MAX_HELD_BYTES) throw new Error('full');
          return store.put(share);
        });
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

  /** The browser's own, which fails the write where storage is refused. */
  var browserStore = {
    bytesHeld: function () {
      return opened().then(function (db) {
        return new Promise(function (resolve, reject) {
          var reading = db.transaction(STORE).objectStore(STORE).getAll();
          reading.onsuccess = function () {
            db.close();
            resolve(reading.result.reduce(function (sum, share) {
              return sum + bytesOf(share);
            }, 0));
          };
          reading.onerror = function () {
            db.close();
            reject(reading.error);
          };
        });
      });
    },
    put: function (share) {
      return opened().then(function (db) {
        return new Promise(function (resolve, reject) {
          var writing = db.transaction(STORE, 'readwrite');
          writing.objectStore(STORE).put(share, share.id);
          writing.oncomplete = function () {
            db.close();
            resolve();
          };
          writing.onabort = function () {
            db.close();
            reject(writing.error);
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
  };

  // Only inside a service worker: loaded anywhere else, it just offers the above.
  if (typeof ServiceWorkerGlobalScope !== 'undefined' && root instanceof ServiceWorkerGlobalScope) {
    root.addEventListener('fetch', function (event) {
      var request = event.request;
      if (!isAShare(request.method, request.url, root.location.origin)) return;
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
