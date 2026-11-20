import { MAX_THUMBNAIL_SIZE, THUMBNAIL_SIDE, thumbnailSource } from '@cockpit/shared';

/**
 * The small copy an Item's thumbnail is drawn from ("Item form: there is no way
 * to mark which image stands for an Item", issue 1863): the largest centred
 * square of the picture the chip already shows, scaled to `THUMBNAIL_SIDE`
 * (`thumbnailSource` says which square), so a card never loads the whole file.
 * A GIF is its first frame. Made on the device, in a canvas, so what the server
 * stores is whatever this browser's encoder made of it.
 */
export async function makeThumbnailCopy(address: string, signal?: AbortSignal): Promise<Blob> {
  const unreadable = () => new Error('That picture could not be read, so it is not the thumbnail.');
  // Fetched and decoded under the caller's signal, so giving up on the copy stops both.
  let picture: ImageBitmap;
  try {
    const response = await fetch(address, signal ? { signal } : undefined);
    if (!response.ok) throw unreadable();
    picture = await createImageBitmap(await response.blob());
  } catch {
    throw unreadable();
  }
  const { x, y, side } = thumbnailSource(picture.width, picture.height);
  if (side <= 0) throw new Error('That picture could not be read, so it is not the thumbnail.');
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
