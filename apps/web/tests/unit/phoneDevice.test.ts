import { describe, expect, it } from 'vitest';
import { onAPhoneDevice, phoneLinksOnThisDevice } from '../../src/phoneDevice';

/**
 * F1, with the browser's device reading replaced: a phone is what the device
 * says it is, never how wide the window is ("Open a Gmail Item at its email on a
 * phone", issue 1837).
 */

const DECLARED = { gmail: { host: 'mail.google.com', path: '/p/', mailboxParam: 'authuser', conversationFragment: 'cv/', draftsFragment: 'tl/d' } };

describe('Open at the source', () => {
  describe('a phone is decided by the device at the tap, not by the window’s width', () => {
    it.each([
      { situation: 'a phone browser that says it is mobile', device: { userAgentData: { mobile: true } }, phone: true },
      {
        situation: 'a phone browser that only gives its user agent',
        device: { userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36' },
        phone: true,
      },
      { situation: 'an iPhone', device: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15' }, phone: true },
      {
        situation: 'Cockpit from a phone’s home screen, which reports as the phone does',
        device: { userAgentData: { mobile: true }, userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/126.0 Mobile Safari/537.36' },
        phone: true,
      },
      {
        situation: 'a desk browser, in a window as narrow as a phone',
        device: { userAgentData: { mobile: false }, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/126.0 Safari/537.36' },
        phone: false,
      },
      { situation: 'a desk browser that gives only its user agent', device: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15' }, phone: false },
      { situation: 'a device that says nothing', device: {}, phone: false },
    ])('$situation', ({ device, phone }) => {
      expect(onAPhoneDevice(device)).toBe(phone);
      expect(phoneLinksOnThisDevice(DECLARED, device)).toBe(phone ? DECLARED : undefined);
    });
  });
});
