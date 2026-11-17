import { describe, expect, it } from 'vitest';
import {
  WAIT_NOT_PUT_BACK,
  statusSteps,
  waitSteps,
  type ItemStatus,
  type StatusState,
  type StatusStep,
} from '../../../src/index.js';

const started = (status: ItemStatus): StatusState => ({ status, started: true, waiting: false });
const unstarted = (status: ItemStatus): StatusState => ({ status, started: false, waiting: false });
const waiting = (status: ItemStatus = 'waiting', hasStarted = false): StatusState => ({ status, started: hasStarted, waiting: true });

/** What each step asks for, in the words a reader of the table would use. */
const said = (step: StatusStep) => {
  if (step.name === 'set_started') return step.started ? 'start' : 'back to To do';
  if (step.name === 'wait_for_reply') return `wait ${step.days}`;
  return step.done ? 'finish' : 'reopen';
};

describe('Triage', () => {
  describe('choosing a status sends what the row would send', () => {
    it.each([
      { situation: 'To do to In progress', from: unstarted('to_do'), to: 'in_progress', sends: ['start'] },
      { situation: 'In progress to To do', from: started('in_progress'), to: 'to_do', sends: ['back to To do'] },
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
        sends: ['reopen', 'back to To do'],
      },
      { situation: 'Done, no start, to To do', from: unstarted('done'), to: 'to_do', sends: ['reopen'] },
      { situation: 'To do to Done', from: unstarted('to_do'), to: 'done', sends: ['finish'] },
      { situation: 'To do to To do', from: unstarted('to_do'), to: 'to_do', sends: [] },
      { situation: 'In progress to In progress', from: started('in_progress'), to: 'in_progress', sends: [] },
      { situation: 'Done to Done', from: started('done'), to: 'done', sends: [] },
      { situation: 'Waiting for reply to In progress', from: waiting(), to: 'in_progress', sends: ['start'] },
      { situation: 'Waiting for reply, started before, to In progress', from: waiting('waiting', true), to: 'in_progress', sends: ['start'] },
      { situation: 'Waiting for reply to To do', from: waiting(), to: 'to_do', sends: ['back to To do'] },
      { situation: 'Waiting for reply to Done, the wait kept', from: waiting(), to: 'done', sends: ['finish'] },
      { situation: 'Done from waiting, to Waiting for reply', from: waiting('done'), to: 'waiting', sends: ['reopen'] },
      { situation: 'Done from waiting, to To do', from: waiting('done'), to: 'to_do', sends: ['reopen', 'back to To do'] },
    ] as const)('$situation', ({ from, to, sends }) => {
      expect(statusSteps(from, to).map(said)).toEqual(sends);
    });

    it('refuses to bring back a wait it would have to set the days of, rather than move the due date', () => {
      expect(() => statusSteps(unstarted('to_do'), 'waiting')).toThrow(WAIT_NOT_PUT_BACK);
    });
  });

  describe('waiting for a reply reopens a finished Item first, and waits again on a waiting one', () => {
    it.each([
      { situation: 'To do', from: unstarted('to_do'), days: 3, sends: ['wait 3'] },
      { situation: 'In progress', from: started('in_progress'), days: 1, sends: ['wait 1'] },
      { situation: 'already waiting', from: waiting(), days: 7, sends: ['wait 7'] },
      { situation: 'Done', from: unstarted('done'), days: 14, sends: ['reopen', 'wait 14'] },
    ] as const)('$situation', ({ from, days, sends }) => {
      expect(waitSteps(from, days).map(said)).toEqual(sends);
    });
  });
});
