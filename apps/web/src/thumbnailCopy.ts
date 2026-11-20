import { MAX_THUMBNAIL_SIZE, THUMBNAIL_SIDE, thumbnailSource } from '@cockpit/shared';

/**
 * The small copy an Item's thumbnail is drawn from ("Item form: there is no way
 * to mark which image stands for an Item", issue 1863): the largest centred
 * square of the picture the chip already shows, scaled to `THUMBNAIL_SIDE`
 * (`thumbnailSource` says which square), so a card never loads the whole file.
 * A GIF is its first frame. Made on the device, in a canvas, so what the server
 * stores is whatever this browser's encoder made of it.
 */
/** The picture itself could not be loaded or decoded: the one failure that says it could not be read. */
export class ThumbnailUnreadable extends Error {
  constructor() {
    super('That picture could not be read, so it is not the thumbnail.');
    this.name = 'ThumbnailUnreadable';
  }
}

export async function makeThumbnailCopy(address: string, signal?: AbortSignal): Promise<Blob> {
  // The picture the chip shows, so the browser's own copy of it is used; `signal` stops the load.
  const picture = new Image();
  const stop = () => {
    picture.src = '';
  };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    picture.src = address;
    await Promise.race([
      picture.decode().catch((failure: unknown) => {
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
        throw failure instanceof Error && failure.name === 'AbortError' ? failure : new ThumbnailUnreadable();
      }),
      new Promise<never>((_, reject) =>
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }),
      ),
    ]);
  } finally {
    signal?.removeEventListener('abort', stop);
  }
  const { x, y, side } = thumbnailSource(picture.naturalWidth, picture.naturalHeight);
  if (side <= 0) throw new ThumbnailUnreadable();
  const canvas = document.createElement('canvas');
  canvas.width = THUMBNAIL_SIDE;
  canvas.height = THUMBNAIL_SIDE;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This device cannot make a thumbnail.');
  context.drawImage(picture, x, y, side, side, 0, 0, THUMBNAIL_SIDE, THUMBNAIL_SIDE);
  const asked = (type: string, quality?: number) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  // WebP keeps a transparent picture transparent; a browser that cannot encode it hands back a PNG,
  // which is also accepted, and one that cannot do that either gets a JPEG on white.
  for (const quality of [0.85, 0.6, 0.4]) {
    const copy = await asked('image/webp', quality);
    if (copy && copy.type === 'image/webp' && copy.size <= MAX_THUMBNAIL_SIZE) return copy;
    if (copy && copy.type === 'image/png') {
      if (copy.size <= MAX_THUMBNAIL_SIZE) return copy;
      break;
    }
  }
  context.globalCompositeOperation = 'destination-over';
  context.fillStyle = 'white';
  context.fillRect(0, 0, THUMBNAIL_SIDE, THUMBNAIL_SIDE);
  const copy = await asked('image/jpeg', 0.8);
  if (!copy || copy.size > MAX_THUMBNAIL_SIZE) throw new Error('This device could not make a small enough thumbnail.');
  return copy;
}
