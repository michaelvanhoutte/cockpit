import { afterAll, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Editor } from '@milkdown/core';
import { endSelection } from '../src/selection';

// vitest doesn't enable jest-style test globals by default, so
// testing-library's own auto-cleanup (which detects a global `afterEach`)
// never registers unless it's wired up explicitly here.
afterEach(cleanup);

// A selection is held by the tab, not by a rendered list, so a test that picked
// a row would otherwise hand it to the next.
afterEach(() => endSelection());

/**
 * Hold a file's teardown until the description editor's timers have fired.
 *
 * Building a Milkdown editor arms a 3-second timeout per stage
 * (`@milkdown/ctx`'s `Timer`, its default `createTimer` timeout) that nothing
 * clears, not even `destroy()`, and that calls the global
 * `removeEventListener` when it fires. A file ending within 3 seconds of its
 * last editor tears jsdom down first, so the timeout throws a `ReferenceError`
 * Vitest reports as an unhandled error, failing a run whose tests all passed.
 *
 * The clock and the wait are the real ones, taken before any test can fake
 * them: an editor built under a faked `Date` would otherwise look days old.
 */
const MILKDOWN_TIMER_TIMEOUT_MS = 3000;
const now = Date.now;
const realSetTimeout = setTimeout;
const pause = (ms: number) => new Promise((settle) => realSetTimeout(settle, ms));
let editorsBuilding = 0;
let lastEditorBuiltAt: number | null = null;
const make = Editor.make.bind(Editor);
Editor.make = () => {
  const editor = make();
  const create = editor.create;
  return Object.assign(editor, {
    create: async () => {
      editorsBuilding += 1;
      try {
        return await create();
      } finally {
        editorsBuilding -= 1;
        lastEditorBuiltAt = now();
      }
    },
  });
};
afterAll(async () => {
  while (editorsBuilding > 0) await pause(50);
  if (lastEditorBuiltAt === null) return;
  const remaining = lastEditorBuiltAt + MILKDOWN_TIMER_TIMEOUT_MS + 50 - now();
  if (remaining > 0) await pause(remaining);
});

/**
 * What ProseMirror needs from a DOM that jsdom does not have. The description
 * editor mounts an `EditorView`, which measures itself on creation and throws
 * without these three; jsdom implements none of them
 * (docs/rich-text-options.md, "Testability and mobile").
 *
 * **They make the editor mount, not work.** The rectangles are all zero and the
 * selection they describe is fictional, so nothing about a caret, a selection
 * or a toolbar press can be proved here - those are F3 walks. What this buys is
 * the level below: parsing and printing a description, which needs a document
 * and no geometry at all.
 */
Range.prototype.getClientRects = () =>
  ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () =>
  ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    bottom: 0,
    right: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
  }) as DOMRect;
document.elementFromPoint = () => null;

/**
 * Pointer capture, which jsdom does not implement at all.
 *
 * A drag keeps receiving moves once the pointer has left the thing it started
 * on - the panel moves out from under the hand almost immediately - and that is
 * what capture is for. Without these two the first `pointerdown` of any drag
 * throws, so this is what lets the gesture be driven here at all; what it
 * cannot stand in for is the capture actually holding, which is a browser
 * behaviour and an F3 walk.
 */
Element.prototype.setPointerCapture = function setPointerCapture() {};
Element.prototype.releasePointerCapture = function releasePointerCapture() {};

/**
 * Object URLs, which jsdom does not implement at all - a queued attachment's
 * thumbnail (`CaptureNote.tsx`) asks for one before it has anything else to
 * show an image by. What it points at is fictional; that a real one really
 * renders the file is a browser behaviour, not something this can prove.
 */
URL.createObjectURL = () => 'blob:mock';
URL.revokeObjectURL = () => {};
