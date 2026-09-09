import { describe, expect, it } from 'vitest';
import {
  TITLE_LENGTH,
  UNTITLED,
  itemDescriptionSchema,
  itemHasOpenReadings,
  itemLabel,
  itemReadingSchema,
  itemSchema,
  itemTitleSchema,
  textsFromCapture,
  workspaceNameSchema,
} from '../../../src/domain/item.js';

/**
 * L1: which names are refused is a pure decision over a string, so this is
 * where it is decided. That the refusal is reachable through a real request -
 * and comes back as a 400 rather than as a 500 - is one case at the interface,
 * in apps/api/tests/integration/http/workspace-management.test.ts.
 *
 * The characters that are the whole point of some of these cases are invisible,
 * so they are written as escapes rather than typed in: a raw U+2028 in source
 * reads as a space and would be lost in the first reformat.
 */
describe('Workspace management', () => {
  describe('a workspace name is a single line', () => {
    it.each([
      { situation: 'a name broken over two lines', typed: 'Réunions\nand more', accepted: false },
      { situation: 'a name with a tab in it', typed: 'Réunions\tand more', accepted: false },
      // Separators rather than control characters, and a browser breaks the
      // line on them just as readily, so a rule that only looked for control
      // characters let them through.
      {
        situation: 'a name broken with a line separator',
        typed: 'Réunions\u2028and more',
        accepted: false,
      },
      {
        situation: 'a name broken with a paragraph separator',
        typed: 'Réunions\u2029and more',
        accepted: false,
      },
      { situation: 'a name of ordinary text', typed: 'Réunions', accepted: true },
      // The joiner holding an emoji together is invisible too, and is not a
      // line break: refusing it would refuse half the emoji anybody would type.
      {
        situation: 'a name with a joined-up emoji in it',
        typed: '\u{1F468}\u200D\u{1F469}\u200D\u{1F467} Family',
        accepted: true,
      },
    ])('$situation', ({ typed, accepted }) => {
      expect(workspaceNameSchema.safeParse(typed).success).toBe(accepted);
    });
  });

  describe('a workspace name is what you typed with the blanks around it removed', () => {
    // The ends are trimmed and only the interior is refused, which is the line
    // between tidying up what surrounds a name and repairing the name itself.
    it.each([
      { situation: 'blanks on both sides', typed: '  Réunions  ', kept: 'Réunions' },
      { situation: 'a line break on the end', typed: 'Réunions\n', kept: 'Réunions' },
    ])('$situation', ({ typed, kept }) => {
      expect(workspaceNameSchema.parse(typed)).toBe(kept);
    });
  });
});

/**
 * L1: what a row shows is a pure decision over an Item's texts, worked out
 * where the row is drawn rather than stored, so this is where it is decided.
 * That a row actually asks it is one case in
 * apps/web/tests/unit/components/ItemRow.test.tsx.
 */
describe('Item editing', () => {
  describe('a row shows the next action, or the title', () => {
    const texts = (over: Partial<Parameters<typeof itemLabel>[0]>) => ({
      nextAction: null,
      title: '',
      ...over,
    });

    it.each([
      {
        situation: 'a next action, which wins over the title',
        item: texts({ nextAction: 'Reply to Tom', title: 'Part 11' }),
        shows: 'Reply to Tom',
      },
      { situation: 'no next action but a title', item: texts({ title: 'Part 11' }), shows: 'Part 11' },
      // Blank is absent, or a row whose title is a space would be a gap where
      // a name should be rather than something a person can read.
      { situation: 'a title of nothing but blanks', item: texts({ title: '   ' }), shows: UNTITLED },
      {
        situation: 'a next action of nothing but blanks',
        item: texts({ nextAction: ' ', title: 'Part 11' }),
        shows: 'Part 11',
      },
      { situation: 'nothing written anywhere', item: texts({}), shows: UNTITLED },
      // Reachable on a title written before a title was one line, and on one
      // an older release stored from a captured message.
      {
        situation: 'a title written over several lines',
        item: texts({ title: 'Ask Tom\n\n  about part 11\t' }),
        shows: 'Ask Tom about part 11',
      },
      // The captured message is a record and never a name: an Item nobody has
      // named reads as Untitled rather than borrowing it back.
      {
        situation: 'nothing but the message it was captured from',
        item: { ...texts({}), capturedMessage: 'Tom asked about part 11' },
        shows: UNTITLED,
      },
    ])('$situation', ({ item, shows }) => {
      expect(itemLabel(item)).toBe(shows);
    });
  });

  describe('a title is a single line, and a description is as long as it needs to be', () => {
    it.each([
      { situation: 'a title over the limit', schema: 'title', typed: 'x'.repeat(201), accepted: false },
      { situation: 'a title at the limit', schema: 'title', typed: 'x'.repeat(200), accepted: true },
      { situation: 'a title of nothing at all', schema: 'title', typed: '', accepted: true },
      // Trimmed before it is measured, so trailing blanks are not what puts a
      // title over: they are not stored either.
      { situation: 'a title at the limit with blanks around it', schema: 'title', typed: `  ${'x'.repeat(200)}  `, accepted: true },
      { situation: 'a title broken over two lines', schema: 'title', typed: 'Part\n11', accepted: false },
      { situation: 'a description over several lines', schema: 'description', typed: 'One\n\nTwo', accepted: true },
      { situation: 'a description over the limit', schema: 'description', typed: 'x'.repeat(60_001), accepted: false },
      { situation: 'a description at the limit', schema: 'description', typed: 'x'.repeat(60_000), accepted: true },
    ])('$situation', ({ schema, typed, accepted }) => {
      const of = schema === 'title' ? itemTitleSchema : itemDescriptionSchema;
      expect(of.safeParse(typed).success).toBe(accepted);
    });
  });

  /**
   * L1: the shape a reading has to have is a pure decision over an object, so
   * this is where it is decided. That an unusable reading is dropped rather
   * than sinking the whole proposal is
   * apps/api/tests/unit/ai/note-texts.test.ts.
   */
  describe('a reading offers a title the form would accept, and may say nothing more', () => {
    const reading = (over: Record<string, unknown> = {}) => ({
      title: 'Call in January',
      description: '',
      meaning: "'jan' is short for the month January",
      ...over,
    });

    it.each([
      { situation: 'a title and a meaning, and nothing more to say', over: {}, accepted: true },
      {
        situation: 'a description as well, where there is more to say',
        over: { description: 'Ring in January about the renewal.' },
        accepted: true,
      },
      { situation: 'a title over the limit', over: { title: 'x'.repeat(201) }, accepted: false },
      { situation: 'a title of nothing at all', over: { title: '' }, accepted: false },
      { situation: 'a title broken over two lines', over: { title: 'Call\nJan' }, accepted: false },
      // A description may be empty, unlike a title - the whole difference
      // between this and the main proposal's own two texts.
      { situation: 'a description over the limit', over: { description: 'x'.repeat(60_001) }, accepted: false },
      { situation: 'no meaning at all', over: { meaning: '' }, accepted: false },
    ])('$situation', ({ over, accepted }) => {
      expect(itemReadingSchema.safeParse(reading(over)).success).toBe(accepted);
    });
  });

  /**
   * L1: the one question a row's mark and a form's picker both ask, in one
   * place, so they cannot drift into asking it differently. That the row and
   * the form actually ask it is apps/web/tests/unit/components/ItemRow.test.tsx
   * and apps/web/tests/unit/components/ItemForm.test.tsx.
   */
  describe('a note reads more than one way only while there is still a choice to make', () => {
    const AN_ALTERNATE_READING = [
      { title: 'Call in January', description: '', meaning: "'jan' is short for January" },
    ];

    it.each([
      {
        situation: 'the note supported more than one reading, unsettled',
        readings: AN_ALTERNATE_READING,
        textsSettledAt: null,
        open: true,
      },
      { situation: 'the note had only the one reading', readings: null, textsSettledAt: null, open: false },
      {
        situation: 'the texts are already somebody\'s own',
        readings: AN_ALTERNATE_READING,
        textsSettledAt: '2026-08-12T10:00:00.000Z',
        open: false,
      },
    ])('$situation', ({ readings, textsSettledAt, open }) => {
      expect(itemHasOpenReadings({ readings, textsSettledAt })).toBe(open);
    });
  });
});

/**
 * L1: which of an Item's texts a captured message becomes is a pure decision
 * over a string. That capture actually asks it is one case in
 * apps/api/tests/unit/domain/items.test.ts, and that a person sees the answer
 * in the box they opened is the walk in tests/e2e/item-editing.test.ts.
 */
describe('Capture', () => {
  describe('what you capture names the item it makes', () => {
    it.each([
      {
        situation: 'a note that fits a title, which is the whole of what it makes',
        typed: 'Ask Novy about part 11',
        named: 'Ask Novy about part 11',
        alsoSays: null,
      },
      {
        situation: 'a note of exactly the length a title holds',
        typed: 'x'.repeat(TITLE_LENGTH),
        named: 'x'.repeat(TITLE_LENGTH),
        alsoSays: null,
      },
      // The whole note, not the part the title left behind: a description that
      // started at the 201st character would read as a sentence cut in half.
      {
        situation: 'a note one character too long for a title',
        typed: 'x'.repeat(TITLE_LENGTH + 1),
        named: 'x'.repeat(TITLE_LENGTH),
        alsoSays: 'x'.repeat(TITLE_LENGTH + 1),
      },
      // A title is one line and a note may be several, so the line breaks close
      // up for the title and the note is kept as it was written.
      {
        situation: 'a note written over several lines',
        typed: 'Ask Novy\nabout part 11',
        named: 'Ask Novy about part 11',
        alsoSays: 'Ask Novy\nabout part 11',
      },
      // Half a character is worse than one character less: the cut lands
      // between the two halves of an emoji, which renders as a broken box.
      {
        situation: 'a note whose cut would land inside a character',
        typed: `${'x'.repeat(TITLE_LENGTH - 1)}\u{1F600}tail`,
        named: 'x'.repeat(TITLE_LENGTH - 1),
        alsoSays: `${'x'.repeat(TITLE_LENGTH - 1)}\u{1F600}tail`,
      },
    ])('$situation', ({ typed, named, alsoSays }) => {
      expect(textsFromCapture(typed)).toEqual({ title: named, description: alsoSays });
    });
  });

  /**
   * The shape read back is permissive on purpose: what is stored has to render
   * even where it predates a rule, and refusing it blanks the screen it is on
   * rather than drawing one row oddly. Found in the browser, not by these:
   * every fixture used a uuid, so nothing here could have caught it.
   */
  describe('a workspace still opens when what it holds predates the rules', () => {
    const anItem = (over: Record<string, unknown> = {}) => ({
      id: '018f0000-0000-7000-8000-000000000001',
      tenantId: 'tenant-default',
      workspaceId: 'ws-work',
      workspaceDecided: true,
      source: 'internal' as const,
      sourceId: null,
      sourceLink: null,
      sender: null,
      sourceTimestamp: null,
      capturedMessage: 'Make appointment with Novy',
      title: '',
      description: null,
      textsSettledAt: null,
      readings: null,
      sourceResolvedAt: null,
      typeId: null,
      nextAction: null,
      completedAt: null,
      priority: null,
      dueDate: null,
      unseen: false,
      deletedAt: null,
      createdAt: '2026-09-04T10:00:00.000Z',
      updatedAt: '2026-09-04T10:00:00.000Z',
      ...over,
    });

    it.each([
      // The two every account starts with have ids derived from the account's
      // own, so an item captured as one of them carries a type id that is not
      // a uuid and never was.
      { situation: 'a type the account started with', over: { typeId: 'tenant-default-type-thought' } },
      { situation: 'a type made by using it', over: { typeId: '018f0000-0000-7000-8000-000000000002' } },
      { situation: 'no type at all', over: { typeId: null } },
      // Capture took an uncapped title until the cap existed, so a title over
      // it can be sitting in a store right now. The whole snapshot is parsed at
      // once, so refusing that one item would blank the workspace rather than
      // draw one row oddly - the cap belongs on the way in, not on the way out.
      { situation: 'a title longer than the cap', over: { title: 'x'.repeat(500) } },
      { situation: 'a title with a line break in it', over: { title: 'Part\n11' } },
      { situation: 'a description longer than the cap', over: { description: 'x'.repeat(70_000) } },
    ])('reads back an item with $situation', ({ over }) => {
      expect(itemSchema.safeParse(anItem(over)).success).toBe(true);
    });
  });
});
