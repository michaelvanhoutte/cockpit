import type { CommandToRun } from '../accounts/answer.js';
import { ATTACHMENT_CONTENT_TYPES, attachmentContentTypeSchema, attachmentFilenameSchema, resolveAttachmentType, uuidv7 } from '@cockpit/shared';

/**
 * The files an app connected to Cockpit adds to an Item and takes off it
 * ("MCP changes and deletes: add and remove files in create_item and
 * update_item", issue 1813): how the arguments are read against the form's own
 * file types and name rule, and how a name is found among the Item's files.
 *
 * **Files ride in the call as base64 and at most 10 MB of them per call**, a
 * lower limit than the form's 25 MB each, because the Worker holds a base64
 * body about three times over (body, string, bytes) inside 128 MB. Every
 * argument is read before any byte is stored.
 *
 * Pure, and proved at L1 (tests/unit/mcp/files.test.ts). Putting the bytes in
 * R2 and recording them is the Worker's (`mcp/server.ts`), proved at L2.
 */

/** A file's name on one line (it is written by whoever sent the file, and a line break would pass for the next field), as `find_items` shows it and `remove_files` is matched against it: whitespace runs collapsed, a blank name called "unnamed". */
export const oneLine = (filename: string) => filename.replace(/\s+/g, ' ').trim() || 'unnamed';

/** The most decoded bytes of files one call may add. */
export const MOST_FILE_BYTES_PER_CALL = 10 * 1024 * 1024;

/**
 * The most bytes of request body `/mcp` reads: the base64 of a full call's files
 * (a third more than the files) and a megabyte for the rest of the call. The
 * transport's own default, 4 MiB, would refuse a call the cap above allows.
 */
export const MOST_BODY_BYTES = Math.ceil((MOST_FILE_BYTES_PER_CALL * 4) / 3) + 1024 * 1024;

/** The most files one call adds, so a call of many tiny files is not many commands. */
export const MOST_FILES_ADDED = 10;

/** The most file names one call removes. */
export const MOST_FILES_REMOVED = 50;

/** The tool's `add_files` argument, as the model reads it. */
export const ADD_FILES_SCHEMA = {
  type: ['array', 'null'],
  maxItems: MOST_FILES_ADDED,
  items: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 255, description: 'The file name, one line, as it is to show on the item.' },
      content_type: { type: 'string', enum: [...ATTACHMENT_CONTENT_TYPES], description: 'The kind of file; only these are accepted.' },
      content_base64: { type: 'string', minLength: 1, description: 'The whole contents of the file, base64.' },
    },
    required: ['name', 'content_type', 'content_base64'],
    additionalProperties: false,
  },
  description: `Files to attach to the item, each with its contents as base64. At most ${MOST_FILES_ADDED} files and ${MOST_FILE_BYTES_PER_CALL / 1024 / 1024} MB of files (decoded) in one call; send larger files in the app.`,
} as const;

/** One file a call adds, read and checked but not yet decoded. */
export interface FileToAdd {
  name: string;
  contentType: string;
  /** The decoded size in bytes. */
  size: number;
  base64: string;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const MEGABYTES = MOST_FILE_BYTES_PER_CALL / 1024 / 1024;

/**
 * The decoded size of a base64 text, or null where it is not base64: standard
 * alphabet, with or without padding, whitespace ignored.
 */
function decodedSize(text: string): number | null {
  const clean = text.replace(/\s+/g, '');
  if (!BASE64.test(clean)) return null;
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const unpadded = clean.length - padding;
  // Padding, where written, completes a group of four; a lone leftover character holds no whole byte.
  if (padding > 0 && clean.length % 4 !== 0) return null;
  if (unpadded % 4 === 1) return null;
  return Math.floor((unpadded * 3) / 4);
}

/**
 * Reads `add_files` against the form's own types and name rule (the
 * contract's schemas, so a limit is never written twice) and the per-call
 * cap. The first file that is wrong is refused by name, and so is a call whose
 * files together are over the cap: nothing is stored for a call refused here.
 *
 * A name ending `.md` or `.txt` sent with no useful type is read as the form
 * reads it (`resolveAttachmentType`).
 */
export function readAddFiles(value: unknown): { ok: true; files: FileToAdd[] } | { ok: false; refusal: string } {
  if (value === undefined || value === null) return { ok: true, files: [] };
  const shape = `add_files must be a list of at most ${MOST_FILES_ADDED} files, each with name, content_type and content_base64.`;
  if (!Array.isArray(value) || value.length > MOST_FILES_ADDED) return { ok: false, refusal: shape };

  const files: FileToAdd[] = [];
  let total = 0;
  for (const one of value) {
    if (!one || typeof one !== 'object') return { ok: false, refusal: shape };
    const given = one as Record<string, unknown>;
    const strange = Object.keys(given).filter((key) => !['name', 'content_type', 'content_base64'].includes(key));
    if (strange.length) return { ok: false, refusal: `${strange.join(', ')} is not a field of a file in add_files; leave it out.` };
    if (typeof given.name !== 'string' || typeof given.content_type !== 'string' || typeof given.content_base64 !== 'string') {
      return { ok: false, refusal: shape };
    }

    const name = attachmentFilenameSchema.safeParse(given.name);
    if (!name.success) {
      return { ok: false, refusal: `${JSON.stringify(given.name.slice(0, 60))} is not a file name Cockpit accepts: one line of 1 to 255 characters, without tabs or line breaks.` };
    }
    const type = attachmentContentTypeSchema.safeParse(resolveAttachmentType(name.data, given.content_type.trim().toLowerCase()));
    if (!type.success) {
      return {
        ok: false,
        refusal: `${JSON.stringify(name.data)} is a kind of file Cockpit does not accept (${JSON.stringify(given.content_type.slice(0, 60))}). It accepts ${ATTACHMENT_CONTENT_TYPES.join(', ')}.`,
      };
    }
    const size = decodedSize(given.content_base64);
    if (size === null) return { ok: false, refusal: `The contents of ${JSON.stringify(name.data)} are not base64.` };
    if (size === 0) return { ok: false, refusal: `${JSON.stringify(name.data)} is empty; a file needs contents.` };
    total += size;
    if (total > MOST_FILE_BYTES_PER_CALL) {
      return {
        ok: false,
        refusal: `The files in one call may be at most ${MEGABYTES} MB together; these are more. Send fewer or smaller files, or add the rest in the app. Nothing was added.`,
      };
    }
    files.push({ name: name.data, contentType: type.data, size, base64: given.content_base64.replace(/\s+/g, '') });
  }
  return { ok: true, files };
}

/** `remove_files`: a list of file names, absent, null or empty being none. */
export function readRemoveFiles(value: unknown): { ok: true; names: string[] } | { ok: false; refusal: string } {
  if (value === undefined || value === null) return { ok: true, names: [] };
  const wrong = { ok: false as const, refusal: `remove_files must be a list of file names, at most ${MOST_FILES_REMOVED}, as find_items shows them.` };
  if (!Array.isArray(value) || value.length > MOST_FILES_REMOVED) return wrong;
  const names: string[] = [];
  for (const one of value) {
    if (typeof one !== 'string' || one.trim() === '') return wrong;
    const name = oneLine(one);
    if (!names.includes(name)) names.push(name);
  }
  return { ok: true, names };
}

/** The bytes of a base64 text already read by `readAddFiles`. */
export function bytesOf(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const quoted = (names: readonly string[]) => names.map((name) => JSON.stringify(name)).join(', ');

/**
 * Finds each name among the files the Item has. **A name the Item has no file
 * of is refused, naming the files it has, and so is a name two of its files
 * share** (the person removes one in the app): nothing is removed for a call
 * refused here.
 */
export function resolveRemovals(
  names: readonly string[],
  files: readonly { id: string; filename: string }[],
): { ok: true; remove: { id: string; filename: string }[] } | { ok: false; refusal: string } {
  const remove: { id: string; filename: string }[] = [];
  for (const name of names) {
    const found = files.filter((file) => oneLine(file.filename) === name);
    if (found.length === 0) {
      return {
        ok: false,
        refusal: files.length
          ? `That item has no file called ${JSON.stringify(name)}. Its files are ${quoted(files.map((file) => oneLine(file.filename)))}.`
          : `That item has no file called ${JSON.stringify(name)}: it has no files.`,
      };
    }
    if (found.length > 1) {
      return {
        ok: false,
        refusal: `${found.length} files on that item are called ${JSON.stringify(name)}, so none was removed. Remove one in the app.`,
      };
    }
    remove.push(found[0]!);
  }
  return { ok: true, remove };
}

/** A file put into R2, as R2 measured it: what `add_attachment` records. */
export interface FileStored {
  attachmentId: string;
  name: string;
  contentType: string;
  /** What R2 says it stored, not what the call declared. */
  size: number;
}

/** The command that records a file already put into R2 under the Item's key. */
export function recordFile(file: FileStored, itemId: string, workspaceId: string, issuedAt: string): CommandToRun {
  return {
    name: 'add_attachment',
    payload: {
      commandId: uuidv7(),
      issuedAt,
      workspaceId,
      attachmentId: file.attachmentId,
      itemId,
      filename: file.name,
      size: file.size,
      contentType: file.contentType as (typeof ATTACHMENT_CONTENT_TYPES)[number],
    },
  };
}

/** What the model is told of files added: names with sizes. */
export function describeAdded(files: readonly FileStored[]): string {
  return files.map((file) => `${JSON.stringify(file.name)} (${size(file.size)})`).join(', ');
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
