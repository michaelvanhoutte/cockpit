import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
   * tests/unit/components/ItemForm.test.tsx. A drop needs layout to say where it
   * lands - ProseMirror measures it before the editor is asked - so a dropped
   * image is the walk in tests/e2e/item-editing.test.ts.
   */
  describe('an image put into the description is drawn at once, where it was put, from the file on the device', () => {
    it.each([
      { situation: 'picked with the image button', put: pick },
      { situation: 'pasted with the cursor in the text', put: paste },
    ])('$situation', async ({ put }) => {
      const { box, changes, uploading, user } = await anEditor('Tolerances');
      await caretIn(user, box, 0, 5);

      await put(user, box, [aFile('photo.png', 'image/png')]);

      // The upload has not answered: the text already holds the final address.
      expect(changes.at(-1)).toBe(`Toler![photo.png](${ADDRESS}1)ances\n`);
      expect(within(box).getByRole('img', { name: 'photo.png' })).toHaveAttribute('src', 'blob:device/photo.png');
      expect(uploading.files()).toEqual(['photo.png']);
    });

    it('draws it from its address once it has uploaded, and lets go of the file', async () => {
      const { box, changes, uploading, user } = await anEditor('Tolerances');
      await caretIn(user, box, 0, 5);
      await paste(user, box, [aFile('photo.png', 'image/png')]);

      uploading.landAll();

      await waitFor(() =>
        expect(within(box).getByRole('img', { name: 'photo.png' })).toHaveAttribute('src', `${ADDRESS}1`),
      );
      expect(changes.at(-1)).toBe(`Toler![photo.png](${ADDRESS}1)ances\n`);
      expect(device.released).toEqual(['blob:device/photo.png']);
    });

    it('keeps drawing it from the file until the browser has the address ready, so it does not flicker', async () => {
      const decoding = holdDecoding();
      const { box, uploading, user } = await anEditor('Tolerances');
      await caretIn(user, box, 0, 5);
      await paste(user, box, [aFile('photo.png', 'image/png')]);

      uploading.landAll();
      await waitFor(() => expect(decoding.asked).toEqual([`${ADDRESS}1`]));
      expect(within(box).getByRole('img', { name: 'photo.png' })).toHaveAttribute('src', 'blob:device/photo.png');
      expect(device.released).toEqual([]);

      decoding.finish();

      await waitFor(() =>
        expect(within(box).getByRole('img', { name: 'photo.png' })).toHaveAttribute('src', `${ADDRESS}1`),
      );
      expect(device.released).toEqual(['blob:device/photo.png']);
    });

    it('takes the file and not the HTML a browser copied with it', async () => {
      const { changes, box, uploading, user } = await anEditor('Tolerances');
      await caretIn(user, box, 0, 5);

      await paste(user, box, [aFile('photo.png', 'image/png')], '<img src="https://elsewhere.example/photo.png">');

      expect(changes.at(-1)).toBe(`Toler![photo.png](${ADDRESS}1)ances\n`);
      expect(uploading.files()).toEqual(['photo.png']);
    });

    it('puts two in at once in the order they were given, however their uploads finish', async () => {
      const { box, changes, uploading, user } = await anEditor('Tolerances');
      await caretIn(user, box, 0, 10);

      await pick(user, box, [aFile('one.png', 'image/png'), aFile('two.png', 'image/png')]);
      uploading.land(1);
      uploading.land(0);

      expect(changes.at(-1)).toBe(`Tolerances\n\n![one.png](${ADDRESS}1)\n\n![two.png](${ADDRESS}2)\n`);
      await waitFor(() => expect(device.released).toHaveLength(2));
    });

    it('puts what is typed right after it after the image, as after a pasted word', async () => {
      const { box, changes, user } = await anEditor('Tolerances');
      await caretIn(user, box, 0, 5);
      await paste(user, box, [aFile('photo.png', 'image/png')]);

      await user.keyboard('XY');

      expect(changes.at(-1)).toBe(`Toler![photo.png](${ADDRESS}1)XYances\n`);
    });

    it('goes just after a code block it was put in, which takes no image', async () => {
      const { box, changes, user } = await anEditor('```\nnpm test\n```');
      await caretIn(user, box, 0, 3, 'code');

      await paste(user, box, [aFile('photo.png', 'image/png')]);

      expect(changes.at(-1)).toBe(`\`\`\`\nnpm test\n\`\`\`\n\n![photo.png](${ADDRESS}1)\n`);
    });
  });

  describe('an image whose upload fails is taken back out of the text', () => {
    it.each([
      { situation: 'in the middle of a line', offset: 5, left: 'Tolerances\n' },
      { situation: 'at the end of a line, where it had a paragraph to itself', offset: 10, left: 'Tolerances\n' },
    ])('$situation', async ({ offset, left }) => {
      const { box, changes, uploading, user } = await anEditor('Tolerances');
      await caretIn(user, box, 0, offset);
      await paste(user, box, [aFile('photo.png', 'image/png')]);
      expect(within(box).getByRole('img', { name: 'photo.png' })).toBeVisible();

      uploading.refuse(0, 'That upload was refused by the server.');

      await waitFor(() => expect(within(box).queryByRole('img')).toBeNull());
      expect(changes.at(-1)).toBe(left);
      expect(device.released).toEqual(['blob:device/photo.png']);
    });

    it('leaves what was typed beside it, and the other images', async () => {
      const { box, changes, uploading, user } = await anEditor('Tolerances');
      await caretIn(user, box, 0, 5);
      await paste(user, box, [aFile('one.png', 'image/png'), aFile('two.png', 'image/png')]);
      await user.keyboard('XY');

      uploading.refuse(0, 'No.');
      uploading.land(1);

      await waitFor(() =>
        expect(changes.at(-1)).toBe(`Toler![two.png](${ADDRESS}2)XYances\n`),
      );
    });

    it('cannot be brought back with Undo, which undoes what was typed before it went', async () => {
      const { box, changes, uploading, user } = await anEditor('Tolerances');
      await caretIn(user, box, 0, 5);
      await paste(user, box, [aFile('photo.png', 'image/png')]);
      // Away from the image, so the typing is an undo step of its own.
      await caretIn(user, box, 0, 0);
      await user.keyboard('Z');
      uploading.refuse(0, 'No.');
      await waitFor(() => expect(within(box).queryByRole('img')).toBeNull());
      expect(changes.at(-1)).toBe('ZTolerances\n');

      await user.keyboard('{Control>}z{/Control}');

      expect(within(box).queryByRole('img')).toBeNull();
      expect(changes.at(-1)).toBe('Tolerances\n');
    });

    it('is not said under the toolbar, the form having said it in the undo bar', async () => {
      const { box, uploading, user } = await anEditor('Tolerances');
      await caretIn(user, box, 0, 5);
      await paste(user, box, [aFile('photo.png', 'image/png')]);

      uploading.refuse(0, 'That upload was refused by the server.');

      await waitFor(() => expect(within(box).queryByRole('img')).toBeNull());
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  describe('a file that cannot go in the text is refused under the toolbar, and never uploaded', () => {
    it.each([
      {
        situation: 'an image over the size limit',
        file: aFile('huge.png', 'image/png', MAX_ATTACHMENT_SIZE + 1),
        said: 'huge.png is over the 25 MB limit.',
      },
      {
        situation: 'an SVG',
        file: aFile('drawing.svg', 'image/svg+xml'),
        said: 'drawing.svg is not an image Cockpit can show. Use PNG, JPEG, GIF or WebP.',
      },
      {
        situation: 'a HEIC photo',
        file: aFile('phone.heic', 'image/heic'),
        said: 'phone.heic is not an image Cockpit can show. Use PNG, JPEG, GIF or WebP.',
      },
    ])('$situation', async ({ file, said }) => {
      const { box, changes, uploading, user } = await anEditor('Tolerances');
      await caretIn(user, box, 0, 5);

      await paste(user, box, [file]);

      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(said));
      expect(within(box).queryByRole('img')).toBeNull();
      expect(uploading.files()).toEqual([]);
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

  describe('a description drawn to be read has no toolbar and takes no typing', () => {
    it('draws the formatted text alone, closed to editing', async () => {
      render(<RichDescription initial="Ring the **supplier**" onChange={() => {}} editable={false} reading fill />);

      const text = await screen.findByLabelText('Description');
      await waitFor(() => expect(text).toHaveAttribute('contenteditable', 'false'));
      expect(within(text).getByText('supplier').tagName).toBe('STRONG');
      expect(screen.queryByRole('toolbar')).toBeNull();
    });
  });

  describe('a description opened by a tap on it puts the cursor in it', () => {
    it('focuses the text once the editor is built, and only when asked to', async () => {
      const { unmount } = render(<RichDescription initial="Tolerances" onChange={() => {}} editable focusWhenReady />);
      const box = await screen.findByLabelText('Description');
      await waitFor(() => expect(box).toHaveFocus());
      unmount();

      render(<RichDescription initial="Tolerances" onChange={() => {}} editable />);
      const other = await screen.findByLabelText('Description');
      await waitFor(() => expect(screen.getByRole('button', { name: 'bold' })).toBeEnabled());
      expect(other).not.toHaveFocus();
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
  const upload = (file: File) => {
    const nth = waiting.length + 1;
    const uploaded = new Promise<void>((resolve, reject) => {
      waiting.push({ file, land: resolve, refuse: (why) => reject(new Error(why)) });
    });
    return { src: `${ADDRESS}${nth}`, uploaded };
  };
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
 * The caret, `offset` characters into the `line`th line drawn as `drawnAs`.
 * jsdom has a selection ProseMirror reads once the document says it moved.
 */
async function caretIn(user: User, box: HTMLElement, line: number, offset: number, drawnAs = 'p') {
  await user.click(box);
  const text = box.querySelectorAll(drawnAs)[line]!.firstChild!;
  window.getSelection()!.collapse(text, offset);
  document.dispatchEvent(new Event('selectionchange'));
  // ProseMirror reads a moved selection on a timer of its own.
  await new Promise((resolve) => setTimeout(resolve, 30));
}

async function pick(user: User, _box: HTMLElement, files: File[]) {
  await user.upload(screen.getByLabelText('Image to put in the description'), files);
}

/**
 * The files on this device, as the editor draws and lets go of them: jsdom has
 * no object URLs, so each is named after its file and every release is noted.
 */
const device = { released: [] as string[] };

beforeEach(() => {
  device.released = [];
  URL.createObjectURL = (file) => `blob:device/${(file as File).name}`;
  URL.revokeObjectURL = (url) => void device.released.push(url);
});

afterEach(() => {
  delete (URL as Partial<typeof URL>).createObjectURL;
  delete (URL as Partial<typeof URL>).revokeObjectURL;
  delete (HTMLImageElement.prototype as Partial<HTMLImageElement>).decode;
});

/** The browser fetching an address to draw, held until `finish`. jsdom loads no images, and has no `decode`. */
function holdDecoding() {
  const asked: string[] = [];
  let finish = () => {};
  const held = new Promise<void>((resolve) => (finish = resolve));
  HTMLImageElement.prototype.decode = function (this: HTMLImageElement) {
    asked.push(this.getAttribute('src') ?? '');
    return held;
  };
  return { asked, finish: () => finish() };
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
