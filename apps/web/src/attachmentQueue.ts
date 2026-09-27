import { MAX_ATTACHMENT_SIZE, attachmentContentTypeSchema } from '@cockpit/shared';

/**
 * The drop/paste validation `ItemForm.tsx` already had, pulled out so
 * `CaptureNote.tsx` can check a file against the same allowlist and cap
 * before an Item even exists to attach it to ("Drop files and paste images
 * while capturing a message", issue 557).
 */

/** A byte count as a person reads it - the units this product's own cap is stated in (issue 441). */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** Whether a drag or a drop actually carries files, as against text or a link. */
export function takesFiles(event: { dataTransfer: DataTransfer | null }): boolean {
  return event.dataTransfer?.types.includes('Files') ?? false;
}

/**
 * Sorts a batch into what the allowlist and the size cap accept, and a
 * rejection message per file that fails either.
 *
 * **Checked whole, before anything happens with any of them** - a rejection
 * two files back in the same drop must not be a message the next, valid
 * file's own success quietly clears.
 */
export function checkAttachmentFiles(files: Iterable<File>): {
  accepted: File[];
  rejections: string[];
} {
  const rejections: string[] = [];
  const accepted: File[] = [];
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_SIZE) {
      rejections.push(`"${file.name}" is over the ${formatFileSize(MAX_ATTACHMENT_SIZE)} limit.`);
    } else if (!attachmentContentTypeSchema.safeParse(file.type).success) {
      rejections.push(`"${file.name}" is not a kind of file Cockpit accepts.`);
    } else {
      accepted.push(file);
    }
  }
  return { accepted, rejections };
}
