import { describe, expect, it } from 'vitest';
import { editedTheProposal } from '../../../src/domain/remembered-sentence.js';

/**
 * L1: when an edit is worth asking about ("Remember an edit as a sentence you
 * confirm", issue 1163): the window and the server both hold to it.
 */

const proposed = { destination: 'cowork', folder: 'C:\\Work', prompt: 'Draft a reply.' };

describe('Agents', () => {
  describe('a sentence is offered only after an edit', () => {
    it.each([
      { situation: 'a prompt left as proposed', sent: proposed, edited: false },
      { situation: 'a prompt differing only in the space round it', sent: { ...proposed, prompt: '  Draft a reply.\n' }, edited: false },
      { situation: 'a folder differing only in the space round it', sent: { ...proposed, folder: ' C:\\Work ' }, edited: false },
      { situation: 'a reworded prompt', sent: { ...proposed, prompt: 'Schrijf een antwoord.' }, edited: true },
      { situation: 'another folder', sent: { ...proposed, folder: 'C:\\Other' }, edited: true },
      { situation: 'another destination', sent: { ...proposed, destination: 'code' }, edited: true },
    ])('$situation', ({ sent, edited }) => {
      expect(editedTheProposal(proposed, sent)).toBe(edited);
    });

    it.each([
      { situation: 'nothing proposed', none: null },
      { situation: 'a proposal with no prompt, as a send with nothing proposed keeps', none: { destination: 'cowork', folder: '', prompt: '' } },
    ])('is never an edit when there was $situation to edit', ({ none }) => {
      expect(editedTheProposal(none, proposed)).toBe(false);
    });
  });
});
