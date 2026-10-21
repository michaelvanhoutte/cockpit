import { ATTACHMENT_CONTENT_TYPES, MAX_ATTACHMENT_SIZE } from '@cockpit/shared';
import { Plugin, PluginKey, type Transaction } from '@milkdown/prose/state';
import type { Node } from '@milkdown/prose/model';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/prose/view';

/**
 * Images put into a description ("Embed an image inline in an item's
 * description", issue 442): each is uploaded as one of the Item's attachments
 * and lands in the text as `![<filename>](<its address>)`, where it was put.
 */

/** The kinds a browser draws in an `<img>`, out of those an attachment may be. */
export const SHOWN = ATTACHMENT_CONTENT_TYPES.filter((type) => type.startsWith('image/')) as readonly string[];

/** Why a file cannot go in the text, or `null` where it can. Checked before any upload. */
export function whyNotInTheText(file: File): string | null {
  if (!file.type.startsWith('image/')) {
    return `Only images go in the description. Add ${file.name} under Attachments.`;
  }
  if (!SHOWN.includes(file.type)) {
    return `${file.name} is not an image Cockpit can show. Use PNG, JPEG, GIF or WebP.`;
  }
  if (file.size > MAX_ATTACHMENT_SIZE) {
    return `${file.name} is over the ${MAX_ATTACHMENT_SIZE / 1024 / 1024} MB limit.`;
  }
  return null;
}

/**
 * Starts putting a file into the Item's attachments. `src` is the address the
 * text will point at, known before the upload; `uploaded` settles when the
 * upload has, rejecting with what to say about it - which the caller has said
 * already, so the editor only takes the image back out.
 */
export type UploadImage = (file: File) => { src: string; uploaded: Promise<void> };

const fromTheDeviceKey = new PluginKey<ReadonlyMap<string, string>>('cockpit-description-device-images');

/**
 * Where each image in the text is drawn from, keyed by its address: the file on
 * the device while it uploads, then the address itself.
 *
 * **A decoration over the image, never a change to it**, so the text holds the
 * final address from the first moment and a Save pressed mid-upload writes it.
 * An entry is never taken away once the upload lands but pointed at the address
 * instead: ProseMirror takes a decoration's attributes off the image by removing
 * them, which would leave it with no `src` at all.
 */
export const imagesFromTheDevice = new Plugin<ReadonlyMap<string, string>>({
  key: fromTheDeviceKey,
  state: {
    init: () => new Map(),
    apply(tr, was) {
      const drawn = tr.getMeta(fromTheDeviceKey) as [string, string][] | undefined;
      return drawn ? new Map([...was, ...drawn]) : was;
    },
  },
  props: {
    decorations(state) {
      const from = fromTheDeviceKey.getState(state);
      if (!from?.size) return null;
      const found: Decoration[] = [];
      state.doc.descendants((node, pos) => {
        const drawn = node.type.name === 'image' && from.get(node.attrs.src as string);
        if (drawn) found.push(Decoration.node(pos, pos + node.nodeSize, { src: drawn }));
        return !node.isInline;
      });
      return DecorationSet.create(state.doc, found);
    },
  },
});

/** Resolves once the browser has the image at `src` ready to draw, or has given up on it. */
function ready(src: string): Promise<unknown> {
  const probe = new Image();
  probe.src = src;
  return typeof probe.decode === 'function' ? probe.decode().catch(() => {}) : Promise.resolve();
}

/**
 * Puts each file in the text at `at` - the drop point - or at the cursor,
 * replacing any selection, the way a paste does; and uploads it.
 *
 * **In the text at once, under its final address**, drawn from the file on the
 * device until the upload has landed and the browser holds the address's own
 * copy, so the swap between the two cannot flicker. An upload that fails takes
 * its image back out, and out of the undo history too, so Undo cannot bring a
 * dead image back.
 *
 * `say` is handed what went wrong with files that were never taken, every time
 * it changes - an empty string where nothing has, which clears what an earlier
 * attempt said. `gone` answers whether the editor has been taken down, after
 * which nothing is drawn: the file is still attached, and the text it went into
 * is no longer anybody's.
 */
export async function putImages(
  view: EditorView,
  files: readonly File[],
  at: number | undefined,
  upload: UploadImage,
  say: (trouble: string) => void,
  gone: () => boolean,
): Promise<void> {
  const trouble: string[] = [];
  const taken: File[] = [];
  for (const file of files) {
    const why = whyNotInTheText(file);
    if (why) trouble.push(why);
    else taken.push(file);
  }
  say(trouble.join(' '));
  if (taken.length === 0) return;

  const { tr } = view.state;
  if (at === undefined) tr.deleteSelection();
  let pos = at ?? tr.selection.from;
  const putIn = [];
  for (const file of taken) {
    const { src, uploaded } = upload(file);
    const device = URL.createObjectURL(file);
    const placed = place(tr, pos, tr.doc.type.schema.node('image', { src, alt: file.name }));
    pos = placed.end;
    putIn.push({ src, device, uploaded, whole: placed.whole });
  }
  view.dispatch(tr.setMeta(fromTheDeviceKey, putIn.map(({ src, device }): [string, string] => [src, device])));

  const alive = () => !gone() && !view.isDestroyed;
  await Promise.all(
    putIn.map(async ({ src, device, uploaded, whole }) => {
      const landed = await uploaded.then(
        () => true,
        () => false,
      );
      if (landed) await ready(src);
      if (alive()) {
        if (landed) view.dispatch(view.state.tr.setMeta(fromTheDeviceKey, [[src, src]]));
        else takeOut(view, src, whole);
      }
      URL.revokeObjectURL(device);
    }),
  );
}

/**
 * The image at `at`: inside the line where it sits mid-text or on an empty
 * line, and a paragraph of its own where it sits at either end of a line,
 * between blocks, or in a line that takes no image - so an image dropped
 * between two paragraphs lands between them rather than on the end of the
 * first. Answers where the next one goes, and whether the paragraph is ours.
 */
function place(tr: Transaction, at: number, image: Node): { end: number; whole: boolean } {
  const { schema } = tr.doc.type;
  const own = () => schema.node('paragraph', null, image);
  const $pos = tr.doc.resolve(at);
  const line = $pos.parent;

  let into = at;
  let node = image;
  if (!line.inlineContent) {
    node = own();
  } else if (!line.canReplaceWith($pos.index(), $pos.index(), image.type)) {
    // A line that takes no image - a code block - gets it after, not lost.
    into = $pos.after();
    node = own();
  } else if (line.content.size > 0 && $pos.parentOffset === 0) {
    into = $pos.before();
    node = own();
  } else if (line.content.size > 0 && $pos.parentOffset === line.content.size) {
    into = $pos.after();
    node = own();
  }
  tr.insert(into, node);
  return { end: into + node.nodeSize, whole: node !== image };
}

/**
 * Takes the image at `src` out of the text, with the paragraph it had to itself
 * if nothing else has been typed into it. Not in the undo history: Undo would
 * bring back an image that was never there.
 */
function takeOut(view: EditorView, src: string, whole: boolean) {
  let at: number | undefined;
  view.state.doc.descendants((node, pos) => {
    if (at === undefined && node.type.name === 'image' && node.attrs.src === src) at = pos;
    return at === undefined;
  });
  if (at === undefined) return;
  const tr = view.state.tr.delete(at, at + 1);
  const $at = tr.doc.resolve(at);
  if (whole && $at.parent.type.name === 'paragraph' && $at.parent.content.size === 0 && tr.doc.childCount > 1) {
    tr.delete($at.before(), $at.after());
  }
  view.dispatch(tr.setMeta('addToHistory', false));
}
