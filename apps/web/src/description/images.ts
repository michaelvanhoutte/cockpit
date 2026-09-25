import { ATTACHMENT_CONTENT_TYPES, MAX_ATTACHMENT_SIZE } from '@cockpit/shared';
import { Plugin, PluginKey, type EditorState } from '@milkdown/prose/state';
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

/** Puts a file into the Item's attachments and answers the address it is served from. */
export type UploadImage = (file: File) => Promise<string>;

type MarkerChange =
  | { kind: 'place'; id: string; name: string; pos: number; order: number }
  | { kind: 'remove'; id: string };

interface MarkerSpec {
  id: string;
  name: string;
  order: number;
}

const markersKey = new PluginKey<DecorationSet>('cockpit-description-uploads');

/**
 * "Uploading photo.png…" where each image will land, for as long as it uploads.
 *
 * **A decoration, not a node**, so it is never in the document: it cannot be
 * saved, serialised or undone, and a Save pressed mid-upload writes the text
 * without it. Mapped through every change, so it moves with the text typed
 * around it and the image lands where it has moved to.
 */
export const uploadMarkers = new Plugin<DecorationSet>({
  key: markersKey,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, set) {
      let next = set.map(tr.mapping, tr.doc);
      for (const change of (tr.getMeta(markersKey) as MarkerChange[] | undefined) ?? []) {
        next = next.remove(next.find(undefined, undefined, (spec: MarkerSpec) => spec.id === change.id));
        if (change.kind === 'place') next = next.add(tr.doc, [marker(change)]);
      }
      return next;
    },
  },
  props: {
    decorations: (state) => markersKey.getState(state),
  },
});

function marker({ id, name, pos, order }: { id: string; name: string; pos: number; order: number }) {
  const spec: MarkerSpec = { id, name, order };
  return Decoration.widget(
    pos,
    () => {
      const dom = document.createElement('span');
      dom.className = 'description-uploading';
      dom.setAttribute('role', 'status');
      dom.textContent = `Uploading ${name}…`;
      return dom;
    },
    // `side` keeps a batch in the order it was given while its markers share a
    // position, and is never negative, so a marker put at the cursor stays
    // ahead of whatever is typed next.
    { ...spec, key: id, side: order, ignoreSelection: true },
  );
}

function markerAt(state: EditorState, id: string): MarkerSpec & { pos: number } | undefined {
  const [found] = markersKey.getState(state)?.find(undefined, undefined, (spec: MarkerSpec) => spec.id === id) ?? [];
  return found && { ...(found.spec as MarkerSpec), pos: found.from };
}

let lastMarker = 0;

/**
 * Uploads each file and puts it in the text at `at` - the drop point - or at
 * the cursor, replacing any selection, the way a paste does.
 *
 * **Uploaded together, landed in order**, so two images put in at once read in
 * the order they were given however their uploads finish. Each one that lands
 * carries the next one's marker to just after it.
 *
 * `say` is handed what went wrong, all of it, every time it changes - an empty
 * string where nothing has, which clears what an earlier attempt said.
 * `gone` answers whether the editor has been taken down, after which nothing
 * lands: the file is still attached, and the text it would have gone into is
 * no longer anybody's.
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
  const taken: { file: File; id: string }[] = [];
  for (const file of files) {
    const why = whyNotInTheText(file);
    if (why) trouble.push(why);
    else taken.push({ file, id: `upload-${(lastMarker += 1)}` });
  }
  say(trouble.join(' '));
  if (taken.length === 0) return;

  const { tr } = view.state;
  let pos = at;
  if (pos === undefined) {
    tr.deleteSelection();
    pos = tr.selection.from;
  }
  const where = pos;
  view.dispatch(
    tr.setMeta(
      markersKey,
      taken.map(({ file, id }, order): MarkerChange => ({ kind: 'place', id, name: file.name, pos: where, order })),
    ),
  );

  const landing = taken.map(({ file, id }) => ({
    file,
    id,
    outcome: upload(file).then(
      (src) => ({ src }),
      (failure: unknown) => ({
        failure: failure instanceof Error ? failure.message : `${file.name} could not be uploaded.`,
      }),
    ),
  }));
  for (const [index, { file, id, outcome: uploading }] of landing.entries()) {
    const outcome = await uploading;
    if (gone() || view.isDestroyed) return;
    if ('src' in outcome) {
      land(view, id, file.name, outcome.src, landing[index + 1]?.id);
    } else {
      view.dispatch(view.state.tr.setMeta(markersKey, [{ kind: 'remove', id }]));
      trouble.push(outcome.failure);
      say(trouble.join(' '));
    }
  }
}

/**
 * The image, where its marker now is: inside the line where the marker sits
 * mid-text or on an empty line, and a paragraph of its own where it sits at
 * either end of a line or between blocks - so an image dropped between two
 * paragraphs lands between them rather than on the end of the first.
 */
function land(view: EditorView, id: string, name: string, src: string, nextId: string | undefined) {
  const found = markerAt(view.state, id);
  if (!found) return;
  const { schema } = view.state;
  const image = schema.node('image', { src, alt: name });
  const own = () => schema.node('paragraph', null, image);
  const tr = view.state.tr;
  const $pos = tr.doc.resolve(found.pos);
  const line = $pos.parent;

  let into = found.pos;
  let node = image;
  if (!line.inlineContent) {
    node = own();
  } else if (line.content.size > 0 && $pos.parentOffset === 0) {
    into = $pos.before();
    node = own();
  } else if (line.content.size > 0 && $pos.parentOffset === line.content.size) {
    into = $pos.after();
    node = own();
  }
  tr.insert(into, node);

  const changes: MarkerChange[] = [{ kind: 'remove', id }];
  const next = nextId && markerAt(view.state, nextId);
  if (next) changes.push({ kind: 'place', ...next, pos: into + node.nodeSize });
  view.dispatch(tr.setMeta(markersKey, changes));
}
