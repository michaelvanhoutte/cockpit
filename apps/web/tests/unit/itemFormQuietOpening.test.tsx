import { StrictMode, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OpensItemForms, useDockedItem, useQuietOpening } from '../../src/itemForm';

/**
 * "Let the item's form dock to the side of the screen instead of opening as a
 * dialog" (issue 481): a switch made with `keepFocus` has to be seen by the
 * form it opens, which reads it while mounting. The app renders under
 * `StrictMode`, which may run a `useState` initializer twice in development
 * and expects it to be pure, so the read must give the same answer both times.
 * The router is the only thing replaced here.
 */
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useSearch: () => ({ item: 'item-1' }),
}));

function TheFormOpeningItem2() {
  const isQuietOpening = useQuietOpening();
  const [quiet] = useState(() => isQuietOpening('item-2'));
  // A second read, as StrictMode's own second call of the initializer is.
  const again = isQuietOpening('item-2');
  return <p>{quiet && again ? 'opened quietly' : 'opened loudly'}</p>;
}

function Switcher({ keepFocus }: { keepFocus: boolean }) {
  const dock = useDockedItem();
  const [switched, setSwitched] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          dock.show('item-2', keepFocus ? { keepFocus } : undefined);
          setSwitched(true);
        }}
      >
        Switch
      </button>
      {switched && <TheFormOpeningItem2 />}
    </>
  );
}

const switching = async (keepFocus: boolean) => {
  render(
    <StrictMode>
      <OpensItemForms>
        <Switcher keepFocus={keepFocus} />
      </OpensItemForms>
    </StrictMode>,
  );
  await userEvent.setup().click(screen.getByRole('button', { name: 'Switch' }));
};

describe('Item editing', () => {
  describe('a form opened by a switch that keeps the keyboard where it is', () => {
    it('is told so on the render that is committed, and again if React reads it a second time', async () => {
      await switching(true);

      expect(screen.getByText('opened quietly')).toBeInTheDocument();
    });

    it('is not told so for an ordinary switch', async () => {
      await switching(false);

      expect(screen.getByText('opened loudly')).toBeInTheDocument();
    });
  });
});
