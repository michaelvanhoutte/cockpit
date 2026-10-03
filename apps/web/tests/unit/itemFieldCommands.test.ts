import { describe, expect, it } from 'vitest';
import type { ItemStatus } from '@cockpit/shared';
import { statusSteps, type StatusState } from '../../src/itemFieldCommands';

describe('Triage', () => {
  describe('choosing a status sends what the row would send', () => {
    const started = (status: ItemStatus): StatusState => ({ status, started: true });
    const unstarted = (status: ItemStatus): StatusState => ({ status, started: false });

    it.each([
      { situation: 'To do to In progress', from: unstarted('to_do'), to: 'in_progress', sends: ['start'] },
      { situation: 'In progress to To do', from: started('in_progress'), to: 'to_do', sends: ['clear the start'] },
      { situation: 'In progress to Done', from: started('in_progress'), to: 'done', sends: ['finish'] },
      { situation: 'Done, start kept, to In progress', from: started('done'), to: 'in_progress', sends: ['reopen'] },
      {
        situation: 'Done, no start, to In progress',
        from: unstarted('done'),
        to: 'in_progress',
        sends: ['reopen', 'start'],
      },
      {
        situation: 'Done, start kept, to To do',
        from: started('done'),
        to: 'to_do',
        sends: ['reopen', 'clear the start'],
      },
      { situation: 'Done, no start, to To do', from: unstarted('done'), to: 'to_do', sends: ['reopen'] },
      { situation: 'To do to Done', from: unstarted('to_do'), to: 'done', sends: ['finish'] },
      { situation: 'To do to To do', from: unstarted('to_do'), to: 'to_do', sends: [] },
      { situation: 'In progress to In progress', from: started('in_progress'), to: 'in_progress', sends: [] },
      { situation: 'Done to Done', from: started('done'), to: 'done', sends: [] },
    ] as const)('$situation', ({ from, to, sends }) => {
      const names = statusSteps(from, to).map((step) => {
        if (step.name === 'set_started') return step.started ? 'start' : 'clear the start';
        return step.done ? 'finish' : 'reopen';
      });

      expect(names).toEqual(sends);
    });
  });
});
