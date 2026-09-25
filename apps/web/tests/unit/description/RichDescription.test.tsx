import { describe, expect, it } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MAX_ATTACHMENT_SIZE } from '@cockpit/shared';
import RichDescription from '../../../src/description/RichDescription';

/**
 * F1: what the editor does the moment something changes in it.
 *
 * Only what a fake selection can reach lives here - a toolbar press with the
 * caret where the editor put it. Anything about a real selection is a walk in
 * tests/e2e/item-editing.test.ts, because jsdom gives ProseMirror rectangles
 * that are all zero and no caret of its own.
 */
describe('Item editing', () => {
  describe('a change to a description is known the moment it is made', () => {
    /**
     * It used to be known 200 milliseconds later, and not at all if the form
     * moved on first: Milkdown's listener debounces, and cancels what is
     * pending when the editor is taken down. So pressing a toolbar button and
     * then Source - or that button and then Save - lost the formatting,
     * silently. The browser walk found it twice before this test existed.
     */
    it('reports the new text without waiting', async () => {
      const changes: string[] = [];
      render(
        <RichDescription initial="Tolerances" onChange={(md) => changes.push(md)} editable />,
      );
      await screen.findByLabelText('Description');
      const user = userEvent.setup();

      await user.click(screen.getByRole('button', { name: 'bullet list' }));

      // Read at once, with nothing waited for beyond the press itself.
      expect(changes.at(-1)).toBe('* Tolerances\n');
    });

    /**
     * And nothing has changed when nothing has. The editor tidies what it
     * parses - `- ` becomes `* ` - so a change reported for the parse itself
     * would rewrite every description that was ever opened, on a Save that was
     * pressed for the title.
     *
     * Driven through the box being closed and opened again, which is what a
     * save in flight does to it, because that is the moment the editor is asked
     * to re-examine a document nobody touched.
     */
    it('says nothing has changed when nothing has', async () => {
      const changes: string[] = [];
      const box = (editable: boolean) => (
        <RichDescription
          initial={'- milk\n- bread'}
          onChange={(md) => changes.push(md)}
          editable={editable}
        />
      );
      const { rerender } = render(box(true));
      await waitFor(() => expect(screen.getByLabelText('Description')).toHaveTextContent('milk'));

      rerender(box(false));
      rerender(box(true));

      expect(changes).toEqual([]);
    });
  });

  describe('a description takes nothing more while it is being saved', () => {
    /**
     * The editor is built asynchronously, so a form that starts saving and then
     * comes back to the formatted view builds a *new* editor with the save
     * already in flight. That one came up writable: the effect that closes it
     * had run once against an editor which did not exist yet, and had no reason
     * to run again.
     */
    it('comes up closed when it is built during a save', async () => {
      render(<RichDescription initial="Tolerances" onChange={() => {}} editable={false} />);

      const box = await screen.findByLabelText('Description');
      await waitFor(() => expect(box).toHaveAttribute('contenteditable', 'false'));
    });

    /**
     * A save that did not land keeps the form open and says why. An address
     * half-typed before Save was pressed used to be waiting when it came back -
     * and being autofocused, it took the cursor off that message.
     */
    it('gives up an address being typed rather than hiding it', async () => {
      const box = (editable: boolean) => (
        <RichDescription initial="Tolerances" onChange={() => {}} editable={editable} />
      );
      const { rerender } = render(box(true));
      await screen.findByLabelText('Description');
      const user = userEvent.setup();
      const link = screen.getByRole('button', { name: 'link' });
      await waitFor(() => expect(link).toBeEnabled());
      await user.click(link);
      await user.type(screen.getByLabelText('Address'), 'example.com/half');

      rerender(box(false));
      rerender(box(true));

      expect(screen.queryByLabelText('Address')).toBeNull();
    });

    it('opens again once the save has landed', async () => {
      const box = (editable: boolean) => (
        <RichDescription initial="Tolerances" onChange={() => {}} editable={editable} />
      );
      const { rerender } = render(box(false));
      await screen.findByLabelText('Description');

      rerender(box(true));

      await waitFor(() =>
        expect(screen.getByLabelText('Description')).toHaveAttribute('contenteditable', 'true'),
      );
    });
  });

  /**
   * Images in a description ("Embed an image inline in an item's description",
   * issue 442), with the upload replaced: what it attaches is the form's, in
   * tests/unit/components/ItemForm.test.tsx. Where a drop lands needs layout,
   * so that is the walk in tests/e2e/item-editing.test.ts.
   */
  describe('an image put into the description lands where it was put, once uploaded', () => {
    it.each([
      { situation: 'picked with the image button', put: pick },
      { situation: 'pasted with the cursor in the text', put: paste },
    ])('$situation', async ({ put }) => {
      const { box, changes, uploading, user } = await anEditor('Tolerances');
      await caretIn(user, box, 0, 5);

      await put(user, box, [aFile('photo.png', 'image/png')]);
      uploading.landAll();

      await waitFor(() => expect(changes.at(-1)).toBe(`Toler![photo.png](${ADDRESS}1)ances\n`));
      expect(within(box).getByRole('img', { name: 'photo.png' })).toHaveAttribute('src', `${ADDRESS}1`);
    });

    it('takes the file and not the HTML a browser copied with it', async () => {
      const { box, changes, uploading, user } = await anEditor('Tolerances');
      await caretIn(user, box, 0, 5);

      await paste(user, box, [aFile('photo.png', 'image/png')], '<img src="https://elsewhere.example/photo.png">');
      uploading.landAll();

      await waitFor(() => expect(changes.at(-1)).toBe(`Toler![photo.png](${ADDRESS}1)ances\n`));
      expect(uploading.files()).toEqual(['photo.png']);
    });

    it('puts two in at once in the order they were given, however their uploads finish', async () => {
      const { box, changes, uploading, user } = await anEditor('Tolerances');
      await caretIn(user, box, 0, 10);

      await pick(user, box, [aFile('one.png', 'image/png'), aFile('two.png', 'image/png')]);
      uploading.land(1);
      uploading.land(0);

      await waitFor(() =>
        expect(changes.at(-1)).toBe(`Tolerances\n\n![one.png](${ADDRESS}1)\n\n![two.png](${ADDRESS}2)\n`),
      );
    });

    it('lands where its marker has moved to when text is typed ahead of it', async () => {
      const { box, changes, uploading, user } = await anEditor('Tolerances');
      await caretIn(user, box, 0, 5);
      await paste(user, box, [aFile('photo.png', 'image/png')]);

      await caretIn(user, box, 0, 2);
      await user.keyboard('XY');
      uploading.landAll();

      await waitFor(() => expect(changes.at(-1)).toBe(`ToXYler![photo.png](${ADDRESS}1)ances\n`));
    });
  });

  describe('while an image uploads, the text says so where it will land', () => {
    it('shows the marker at the cursor, and nothing in what is stored', async () => {
      const { box, changes, user } = await anEditor('Tolerances');
      await caretIn(user, box, 0, 5);

      await paste(user, box, [aFile('photo.png', 'image/png')]);

      expect(within(box).getByRole('status')).toHaveTextContent('Uploading photo.png…');
      expect(box).toHaveTextContent('TolerUploading photo.png…ances');
      expect(changes).toEqual([]);
    });
  });

  describe('an image that does not land leaves nothing in the text and says why under the toolbar', () => {
    it.each([
      {
        situation: 'the upload is refused',
        file: aFile('photo.png', 'image/png'),
        refusal: 'That upload was refused by the server.',
        said: 'That upload was refused by the server.',
        uploaded: ['photo.png'],
      },
      {
        situation: 'an image over the size limit',
        file: aFile('huge.png', 'image/png', MAX_ATTACHMENT_SIZE + 1),
        said: 'huge.png is over the 25 MB limit.',
        uploaded: [],
      },
      {
        situation: 'an SVG',
        file: aFile('drawing.svg', 'image/svg+xml'),
        said: 'drawing.svg is not an image Cockpit can show. Use PNG, JPEG, GIF or WebP.',
        uploaded: [],
      },
      {
        situation: 'a HEIC photo',
        file: aFile('phone.heic', 'image/heic'),
        said: 'phone.heic is not an image Cockpit can show. Use PNG, JPEG, GIF or WebP.',
        uploaded: [],
      },
    ])('$situation', async ({ file, refusal, said, uploaded }) => {
      const { box, changes, uploading, user } = await anEditor('Tolerances');
      await caretIn(user, box, 0, 5);

      await paste(user, box, [file]);
      if (refusal) uploading.refuse(0, refusal);

      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(said));
      expect(within(box).queryByRole('status')).toBeNull();
      expect(uploading.files()).toEqual(uploaded);
      expect(changes).toEqual([]);
    });
  });

  describe('only images go into the description text', () => {
    it('refuses a video pasted into it, naming Attachments', async () => {
      const { box, changes, uploading, user } = await anEditor('Tolerances');
      await caretIn(user, box, 0, 5);

      await paste(user, box, [aFile('clip.mp4', 'video/mp4')]);

      expect(screen.getByRole('alert')).toHaveTextContent(
        'Only images go in the description. Add clip.mp4 under Attachments.',
      );
      expect(uploading.files()).toEqual([]);
      expect(changes).toEqual([]);
    });
  });

  describe('only an item’s description offers images', () => {
    it('offers no image button, and takes no pasted image, in a panel’s text', async () => {
      const changes: string[] = [];
      render(<RichDescription initial="Tolerances" onChange={(md) => changes.push(md)} editable />);
      const box = await screen.findByLabelText('Description');
      await waitFor(() => expect(screen.getByRole('button', { name: 'bold' })).toBeEnabled());
      const user = userEvent.setup();
      await caretIn(user, box, 0, 5);

      await paste(user, box, [aFile('photo.png', 'image/png')]);

      expect(screen.queryByRole('button', { name: 'image' })).toBeNull();
      expect(within(box).queryByRole('status')).toBeNull();
      expect(changes).toEqual([]);
    });
  });
});

/** What the replaced upload answers for the nth file it is handed, counting from 1. */
const ADDRESS = '/v1/attachments/uploaded-';

type User = ReturnType<typeof userEvent.setup>;

function aFile(name: string, type: string, size?: number): File {
  const file = new File(['bytes'], name, { type });
  if (size !== undefined) Object.defineProperty(file, 'size', { value: size });
  return file;
}

/**
 * Uploads that wait to be told how they end, so a test can hold one in flight,
 * or finish a batch out of order.
 */
function heldUploads() {
  const waiting: { file: File; land: () => void; refuse: (why: string) => void }[] = [];
  const upload = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const nth = waiting.length + 1;
      waiting.push({
        file,
        land: () => resolve(`${ADDRESS}${nth}`),
        refuse: (why) => reject(new Error(why)),
      });
    });
  return {
    upload,
    files: () => waiting.map(({ file }) => file.name),
    land: (index: number) => waiting[index]!.land(),
    landAll: () => waiting.forEach(({ land }) => land()),
    refuse: (index: number, why: string) => waiting[index]!.refuse(why),
  };
}

async function anEditor(initial: string) {
  const changes: string[] = [];
  const uploading = heldUploads();
  render(
    <RichDescription
      initial={initial}
      onChange={(md) => changes.push(md)}
      editable
      uploadImage={uploading.upload}
    />,
  );
  const box = await screen.findByLabelText('Description');
  await waitFor(() => expect(screen.getByRole('button', { name: 'image' })).toBeEnabled());
  return { box, changes, uploading, user: userEvent.setup() };
}

/**
 * The caret, `offset` characters into the `paragraph`th paragraph. jsdom
 * has a selection ProseMirror reads once the document says it moved.
 */
async function caretIn(user: User, box: HTMLElement, paragraph: number, offset: number) {
  await user.click(box);
  const text = box.querySelectorAll('p')[paragraph]!.firstChild!;
  window.getSelection()!.collapse(text, offset);
  document.dispatchEvent(new Event('selectionchange'));
  // ProseMirror reads a moved selection on a timer of its own.
  await new Promise((resolve) => setTimeout(resolve, 30));
}

async function pick(user: User, _box: HTMLElement, files: File[]) {
  await user.upload(screen.getByLabelText('Image to put in the description'), files);
}

/** A paste, carrying files and whatever HTML the clipboard held beside them. */
async function paste(_user: User, box: HTMLElement, files: File[], html = '') {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      files,
      types: html ? ['Files', 'text/html'] : ['Files'],
      getData: (type: string) => (type === 'text/html' ? html : ''),
    },
  });
  await act(async () => {
    box.dispatchEvent(event);
  });
}
