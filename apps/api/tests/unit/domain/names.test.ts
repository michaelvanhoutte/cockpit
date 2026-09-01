import { describe, expect, it } from 'vitest';
import { foldName, namedTheSame } from '../../../src/domain/names.js';

/**
 * L1: which names count as the same one, and which of a list is in the way, are
 * pure decisions over strings. That the second name is then actually refused -
 * by the handler, and by the index behind it - is proved against a real
 * database in tests/integration.
 *
 * The area is Workspace management because that is where these rules are met
 * first and where their failure shows; the same two functions decide a
 * dashboard's name, and Dashboards has its own cases for the scope that
 * differs.
 */
describe('Workspace management', () => {
  describe('two names are the same name when only their case differs, in any alphabet', () => {
    it.each([
      { situation: 'the same accented name in another case', one: 'ÉTÉ', other: 'été', same: true },
      {
        situation: 'the same plain name in another case',
        one: 'Personal',
        other: 'personal',
        same: true,
      },
      // Lower case alone would leave these two apart: `STRASSE` lowercases to
      // `strasse` while `Straße` stays as it is. Upper case expands the sharp
      // s first, which is what makes them meet.
      {
        situation: 'a name whose sharp s is written out in the other case',
        one: 'STRASSE',
        other: 'Straße',
        same: true,
      },
      {
        situation: 'a name that differs by an accent rather than by case',
        one: 'Reunions',
        other: 'Réunions',
        same: false,
      },
      {
        situation: 'the same name with blanks around one of them',
        one: '  Réunions ',
        other: 'Réunions',
        same: true,
      },
    ])('$situation', ({ one, other, same }) => {
      expect(foldName(one) === foldName(other)).toBe(same);
    });
  });

  describe('what is already going by a name is found, except the one asking', () => {
    const taken = [
      { id: 'ws-work', name: 'Work' },
      { id: 'ws-personal', name: 'Personal' },
    ];

    it.each([
      { situation: 'a name nothing has', name: 'Bookkeeping', asking: undefined, found: undefined },
      { situation: 'a name something has', name: 'Personal', asking: undefined, found: 'ws-personal' },
      {
        situation: 'that name in another case',
        name: 'PERSONAL',
        asking: undefined,
        found: 'ws-personal',
      },
      // The row it folds onto is itself, which is what makes renaming
      // `Personal` to `PERSONAL` collide with nothing.
      {
        situation: 'its own name, asked by the one holding it',
        name: 'PERSONAL',
        asking: 'ws-personal',
        found: undefined,
      },
      {
        situation: 'another one’s name, asked by the one holding a different name',
        name: 'Work',
        asking: 'ws-personal',
        found: 'ws-work',
      },
    ])('$situation', ({ name, asking, found }) => {
      expect(namedTheSame(taken, name, asking)?.id).toBe(found);
    });
  });
});
