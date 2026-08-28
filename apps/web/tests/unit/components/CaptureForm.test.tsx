import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CaptureForm } from '../../../src/components/CaptureForm';
import { useCommand } from '../../../src/api/queries';

vi.mock('../../../src/api/queries', () => ({ useCommand: vi.fn() }));

const mockUseCommand = vi.mocked(useCommand);

describe('Capture', () => {
  describe('capturing a thought sends it and leaves the box ready for the next one', () => {
    it('asks to capture what was typed, then empties the box', async () => {
      const mutate = vi.fn();
      mockUseCommand.mockReturnValue({ mutate, isPending: false } as never);
      const user = userEvent.setup();

      render(<CaptureForm workspaceId="ws-work" />);
      const box = screen.getByLabelText('Capture a note or to-do');
      await user.type(box, '  Buy milk  ');
      await user.click(screen.getByRole('button', { name: 'Capture' }));

      expect(mutate).toHaveBeenCalledTimes(1);
      const [asked] = mutate.mock.calls[0]!;
      expect(asked.name).toBe('capture_item');
      expect(asked.payload.title).toBe('Buy milk');
      expect(asked.payload.workspaceId).toBe('ws-work');
      expect(box).toHaveValue('');
    });
  });

  describe('an empty thought is never captured', () => {
    it('asks for nothing when the box holds only spaces', async () => {
      const mutate = vi.fn();
      mockUseCommand.mockReturnValue({ mutate, isPending: false } as never);
      const user = userEvent.setup();

      render(<CaptureForm workspaceId="ws-work" />);
      await user.type(screen.getByLabelText('Capture a note or to-do'), '   ');
      await user.click(screen.getByRole('button', { name: 'Capture' }));

      expect(mutate).not.toHaveBeenCalled();
    });
  });
});
