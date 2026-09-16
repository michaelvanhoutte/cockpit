import { z } from 'zod';
import { isSingleLine } from './item.js';

/**
 * What an Item's attachment may be - images, short clips and documents small
 * enough that Cockpit's own store can hold their metadata cheaply while the
 * bytes themselves go to R2 (architecture.md §4.1, "attachments go to R2";
 * "Attach a file to an item", issue 441).
 */
export const ATTACHMENT_CONTENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'application/pdf',
] as const;
export const attachmentContentTypeSchema = z.enum(ATTACHMENT_CONTENT_TYPES);
export type AttachmentContentType = z.infer<typeof attachmentContentTypeSchema>;

/** 25MB (issue 441) - refused before the upload route reads a byte of the body. */
export const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;

/**
 * A single line, the same predicate `workspaceNameSchema` takes
 * (`domain/item.ts`'s `isSingleLine`) - refused rather than cleaned up if it
 * holds a tab or a line break. Its own schema rather than an alias, unlike
 * `panelNameSchema`/`itemTypeNameSchema`/`screenSizeNameSchema`, because a
 * filename's cap is 255, not 60.
 */
export const attachmentFilenameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(isSingleLine, { message: 'a filename is a single line, without tabs or line breaks' });

/**
 * One file attached to an Item, as the workspace snapshot reads it back -
 * metadata only, never the bytes (issue 441's own read-model test case: "an
 * item with attachments, read back in the workspace snapshot - filename,
 * size, type and id for each - never the bytes").
 *
 * **`id`/`itemId` are validated `z.uuid()`, not the permissive read-back
 * shape most domain schemas give theirs.** Attachments are a brand-new
 * table with no row written before client-generated ids existed, the same
 * reasoning `associationSchema` (`domain/item.ts`) already applies to its own.
 */
export const attachmentSchema = z.object({
  id: z.uuid(),
  tenantId: z.string(),
  itemId: z.uuid(),
  /** Permissive on read, for the reason every read-back field is (architecture.md §4.4) - `attachmentFilenameSchema` is where the cap is enforced, on the way in. */
  filename: z.string(),
  size: z.number().int(),
  /** Permissive on read too: a narrower allowlist later must not blank an Item's attachment uploaded under a wider one. */
  contentType: z.string(),
  createdAt: z.iso.datetime(),
});
export type Attachment = z.infer<typeof attachmentSchema>;
