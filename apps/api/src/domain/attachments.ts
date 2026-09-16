import type { AddAttachmentCommand } from '@cockpit/shared';

/**
 * The R2 object key one attachment's bytes are stored under - account- and
 * item-scoped, the shape issue 441's own upload test case asks for.
 * Deterministic from the three ids alone, so nothing has to look it up
 * before naming it: the upload route computes this same key once before
 * writing to R2 (`apps/api/src/http/app.ts`) and once again here, for the
 * row that remembers it.
 */
export function attachmentR2Key(tenantId: string, itemId: string, attachmentId: string): string {
  return `${tenantId}/${itemId}/${attachmentId}`;
}

/** One row of `attachments` (`accounts/schema.ts`), from the command that creates it. */
export interface AttachmentRow {
  id: string;
  tenantId: string;
  itemId: string;
  r2Key: string;
  filename: string;
  size: number;
  contentType: string;
  createdAt: string;
}

/**
 * What the download route reads (`apps/api/src/http/app.ts`) - an
 * `AttachmentRow` cut down to what serving the file back needs, named once
 * here and imported everywhere it is passed across a layer: `repo.ts`,
 * `store.ts`, `rpc.ts` and `index.ts`, the same way `PinnedExampleEntry`
 * (`domain/pinned-text-examples.ts`) is.
 */
export type AttachmentForDownload = Pick<
  AttachmentRow,
  'id' | 'itemId' | 'r2Key' | 'filename' | 'contentType'
>;

export function attachmentFromCommand(cmd: AddAttachmentCommand, tenantId: string): AttachmentRow {
  return {
    id: cmd.attachmentId,
    tenantId,
    itemId: cmd.itemId,
    r2Key: attachmentR2Key(tenantId, cmd.itemId, cmd.attachmentId),
    filename: cmd.filename,
    size: cmd.size,
    contentType: cmd.contentType,
    createdAt: cmd.issuedAt,
  };
}
