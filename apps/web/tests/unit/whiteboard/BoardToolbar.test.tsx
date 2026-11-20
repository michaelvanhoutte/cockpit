import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { BoardToolbar } from '../../../src/whiteboard/BoardToolbar';

/**
 * F1: a whiteboard's toolbar ("Brainstorming: give every Dashboard a whiteboard
 * of its own", issue 1829). That it sits in one row at a desk and its icons fit
 * a narrow board is the browser walk's (`tests/e2e/whiteboard.test.ts`), since
 * jsdom measures nothing; what it offers is here.
 */
function theToolbar(over: { narrow?: boolean; readOnly?: boolean } = {}) {
  const nothing = () => {};
  render(
    <BoardToolbar
      tool="select"
      onTool={nothing}
      grid
      onGrid={nothing}
      zoom={1}
      onZoomIn={nothing}
      onZoomOut={nothing}
      onFit={nothing}
      full={false}
      onFull={nothing}
      narrow={over.narrow ?? false}
      readOnly={over.readOnly ?? false}
    />,
  );
}

describe('Whiteboard', () => {
  describe('the toolbar reads Select · Draw box, as words on a wide board and icons on a narrow one', () => {
    it.each([
      { situation: 'a wide board', narrow: false, words: ['Select', 'Draw box'] },
      { situation: 'a narrow board', narrow: true, words: ['', ''] },
    ])('on $situation', ({ narrow, words }) => {
      theToolbar({ narrow });
      const tools = screen.getByRole('toolbar', { name: 'Whiteboard tools' });
      const buttons = within(tools).getAllByRole('button').slice(0, 2);
      expect(buttons.map((one) => one.getAttribute('aria-label'))).toEqual(['Select', 'Draw box']);
      expect(buttons.map((one) => one.textContent)).toEqual(words);
      expect(within(tools).getByRole('button', { name: 'Select' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('offers no tools on a board only to look at, and keeps Fit and Full screen', () => {
      theToolbar({ readOnly: true });
      expect(screen.queryByRole('toolbar', { name: 'Whiteboard tools' })).toBeNull();
      const zoom = screen.getByRole('toolbar', { name: 'Zoom' });
      expect(within(zoom).getByRole('button', { name: 'Fit' })).toBeVisible();
      expect(within(zoom).getByRole('button', { name: 'Full screen' })).toBeVisible();
    });
  });
});
