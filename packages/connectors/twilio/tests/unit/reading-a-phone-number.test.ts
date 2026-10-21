import { describe, expect, it } from 'vitest';
import { createTwilioConnector } from '../../src/index.js';

/**
 * L1: reading what was typed is pure. That the connect route asks it before
 * Verify is called is the integration tier's
 * (apps/api/tests/integration/connectors/connecting-a-phone.test.ts).
 */

const connector = createTwilioConnector({
  accountSid: 'AC-the-account',
  authToken: 'a-token',
  verifyServiceSid: 'VA-the-service',
  number: '+32 460 00 00 00',
});

describe('Connector management', () => {
  describe('only a Belgian mobile number can be sent a code', () => {
    it.each([
      { situation: 'written with its country code', typed: '+32 470 12 34 56' },
      { situation: 'written with its country code and no spaces', typed: '+32470123456' },
      { situation: 'written nationally, with a leading zero', typed: '0470 12 34 56' },
      { situation: 'written with dots between the digits', typed: '0470.12.34.56' },
      { situation: 'written with 0032 for the country code', typed: '0032 470 12 34 56' },
      { situation: 'written with the leading zero kept in brackets', typed: '+32 (0)470 12 34 56' },
      { situation: 'written with the spaces somebody pasted around it', typed: '  +32 470 12 34 56 ' },
    ])('accepts a number $situation as +32470123456', ({ typed }) => {
      expect(connector.numberFrom!(typed)).toEqual({ number: '+32470123456' });
    });

    it.each([
      { situation: 'a Belgian landline', typed: '+32 2 123 45 67' },
      { situation: 'a Liège landline written nationally', typed: '04 123 45 67' },
      { situation: 'a Dutch mobile', typed: '+31 6 12345678' },
      { situation: 'a number with letters in it', typed: '+32 470 12 34 ab' },
      { situation: 'a number with too few digits', typed: '+32 470 12 34' },
      { situation: 'a number with too many digits', typed: '+32 470 12 34 567' },
      { situation: 'a number with no country code or leading zero', typed: '470 12 34 56' },
      { situation: 'a Belgian mobile prefix after another country code', typed: '+44 470 12 34 56' },
      { situation: 'nothing', typed: '' },
      { situation: 'only spaces', typed: '   ' },
    ])('refuses $situation, saying only Belgian mobile numbers are accepted', ({ typed }) => {
      const read = connector.numberFrom!(typed);

      expect(read).toEqual({ refused: expect.stringContaining('Belgian mobile') });
    });
  });
});
