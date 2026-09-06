import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// vitest doesn't enable jest-style test globals by default, so
// testing-library's own auto-cleanup (which detects a global `afterEach`)
// never registers unless it's wired up explicitly here.
afterEach(cleanup);

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
