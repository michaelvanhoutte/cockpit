import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NameQuestion } from '../../../src/components/NameQuestion';

/**
 * F1, and on the question itself rather than on the pages that ask it. Every
 * name the app asks for in a dialog is this one component - a new dashboard, a
 * new panel, a new layout, a layout being renamed - so a rule about how it
 * behaves belongs here, and the pages are left proving only that they hand it
 * the right words ("Prove the shared menu's and the delete question's rules on
 * the menu and the question, not on every page that uses them", issue 134).
 */

function ask(explains?: string) {
  render(
    <NameQuestion
      question="What is the new thing called?"
      // Spread rather than passed as undefined, because the prop being *absent*
      // is the case under test - `exactOptionalPropertyTypes` tells the two
      // apart, and so does the dialog.
      {...(explains ? { explains } : {})}
      fieldLabel="Name of the new thing"
      placeholder="Something…"
      submitLabel="Add"
      name=""
      open
      onNameChange={vi.fn()}
      onSubmit={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
}

describe('Across the app', () => {
  /**
   * The two shapes this question comes in. One is asked where something is
   * *made*, which is the moment somebody is asking what the thing is; the other
   * renames what they already have in front of them, and has nothing to explain.
   */
  describe('a question that makes something says what it makes, and one that renames says only the name', () => {
    it('is described by the explanation it was given', () => {
      ask('A view inside one workspace, switched to like a tab.');

      expect(screen.getByRole('dialog')).toHaveAccessibleDescription(
        'A view inside one workspace, switched to like a tab.',
      );
    });

    it('carries no description at all where it was given none', () => {
      // Not an empty one: the dialog says out loud that the omission is
      // deliberate, which is also what keeps the console clean.
      ask();

      expect(screen.getByRole('dialog')).toHaveAccessibleDescription('');
      expect(screen.getByRole('dialog')).not.toHaveAttribute('aria-describedby');
    });

    it('asks its question either way', () => {
      ask();

      expect(screen.getByRole('dialog', { name: 'What is the new thing called?' })).toBeVisible();
      expect(screen.getByLabelText('Name of the new thing')).toBeVisible();
    });
  });
});
