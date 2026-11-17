import { describe, expect, it } from 'vitest';
import type { ItemStatus, StatusState } from '@cockpit/shared';
import { fieldWrites } from '../../src/itemFieldCommands';

const unstarted = (status: ItemStatus): StatusState => ({ status, started: false, waiting: false });
const waiting = (status: ItemStatus = 'waiting', hasStarted = false): StatusState => ({ status, started: hasStarted, waiting: true });

describe('Triage', () => {
  describe('undoing a wait puts back the due date, then the status it replaced, keeping any run the wait left open', () => {
    const envelope = () => ({ commandId: 'c', issuedAt: '2026-10-23T10:00:00.000Z', workspaceId: 'ws', itemId: 'i' });
    const sent = (back: Parameters<typeof fieldWrites>[2], from: StatusState) =>
      fieldWrites('wait', envelope, back, from).map(({ command }) => {
        if (command.name === 'set_due_date') return `due ${command.payload.dueDate ?? 'none'}`;
        if (command.name === 'set_started') {
          if (!command.payload.keepsRun) return 'a status chosen';
          return command.payload.started ? 'start' : 'back to To do';
        }
        if (command.name === 'set_done') return command.payload.done ? 'finish' : 'reopen';
        return command.name;
      });

    it.each([
      {
        situation: 'a wait set on a To do Item',
        back: { status: 'to_do', started: false, waiting: false, dueDate: null },
        sends: ['due none', 'back to To do'],
      },
      {
        situation: 'a wait set on an In progress Item',
        back: { status: 'in_progress', started: true, waiting: false, dueDate: '2026-11-02' },
        sends: ['due 2026-11-02', 'start'],
      },
      {
        situation: 'a wait set again on a waiting Item',
        back: { status: 'waiting', started: false, waiting: true, dueDate: '2026-10-20' },
        sends: ['due 2026-10-20'],
      },
      {
        situation: 'a wait set on a Done Item that never waited',
        back: { status: 'done', started: false, waiting: false, dueDate: null },
        sends: ['due none', 'back to To do', 'finish'],
      },
      {
        situation: 'a wait set on a Done Item that was waiting',
        back: { status: 'done', started: false, waiting: true, dueDate: '2026-10-20' },
        sends: ['due 2026-10-20', 'finish'],
      },
    ] as const)('$situation', ({ back, sends }) => {
      expect(sent(back, waiting())).toEqual(sends);
    });

    it('sends the wait itself with the days and the device’s time zone', () => {
      const [write] = fieldWrites('wait', envelope, 7, unstarted('to_do'), 'Europe/Brussels');
      expect(write?.command).toMatchObject({ name: 'wait_for_reply', payload: { days: 7, timeZone: 'Europe/Brussels' } });
      expect(write?.held).toEqual(waiting('waiting', false));
    });
  });
});
