import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { DockedItemContext, type DockedItem } from '../../src/itemForm';
import { useCapture } from '../../src/capture';

/**
 * "Let the item's form dock to the side of the screen instead of opening as a
 * dialog" (issue 481): with a form docked open, capturing moves it to what was
 * just captured. Whether the keyboard really stays in the capture box is a
 * real focus and a real dialog, so `tests/e2e/item-editing.test.ts`'s claim;
 * what is decided here is only when the dock is asked to move, and how.
 */
const held = vi.hoisted(() => ({
  mutate: vi.fn(),
}));

vi.mock('../../src/api/queries', () => ({
  useCommand: () => ({ mutate: held.mutate, isPending: false }),
}));

const captureOneNote = (dock: DockedItem) => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <DockedItemContext.Provider value={dock}>{children}</DockedItemContext.Provider>
  );
  const { result } = renderHook(() => useCapture(), { wrapper });
  result.current.ask(
    { workspaceId: 'ws-1', message: 'Call Jan', typeId: 'type-1', decided: true },
    { refused: () => {} },
  );
  const [command, options] = held.mutate.mock.calls[0]!;
  return { itemId: command.payload.itemId as string, land: () => options.onSuccess() };
};

describe('capturing while a form is docked open', () => {
  beforeEach(() => held.mutate.mockReset());

  it('moves the dock to the new note once it has landed, keeping the keyboard where it is', () => {
    const show = vi.fn();
    const { itemId, land } = captureOneNote({ openId: 'item-open', show });

    expect(show).not.toHaveBeenCalled();
    land();

    expect(show).toHaveBeenCalledExactlyOnceWith(itemId, { keepFocus: true });
  });

  it('leaves everything alone where no form is docked open', () => {
    const show = vi.fn();
    const { land } = captureOneNote({ openId: null, show });

    land();

    expect(show).not.toHaveBeenCalled();
  });
});
