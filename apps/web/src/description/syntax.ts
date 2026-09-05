import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';

/**
 * What a description is allowed to contain: CommonMark, plus GitHub's tables,
 * strikethrough and task lists.
 *
 * **Wider than the toolbar, deliberately.** Headings, tables, images, code
 * blocks and strikethrough get no button in this issue and are parsed anyway,
 * because a ProseMirror schema deletes what it does not know: with a
 * toolbar-shaped schema, a table pasted out of Notion vanishes the moment the
 * Item is opened - silently, and with no undo. Measured, not assumed: the same
 * paste through a schema without the table extension came back with the table
 * gone (docs/rich-text-options.md, "Fidelity, measured").
 *
 * **The CommonMark preset's `html` node stays in.** It renders raw HTML as
 * escaped text rather than as markup, which is both the safe answer and the
 * one that keeps what was pasted; taking it out would delete it instead.
 *
 * Its own module so that what a description carries is one list, and the test
 * for what a description keeps reads the same list the form does.
 */
export const descriptionSyntax = [commonmark, gfm].flat();
