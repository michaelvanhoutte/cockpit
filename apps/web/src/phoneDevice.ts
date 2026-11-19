import type { DeclaredPhoneLinks } from '@cockpit/shared';

/** What a browser says of the device it runs on: the two readings `onAPhoneDevice` asks, either possibly missing. */
export interface DeviceReading {
  userAgentData?: { mobile?: boolean };
  userAgent?: string;
}

/**
 * Whether this is a phone, as the device says it ("Open a Gmail Item at its
 * email on a phone", issue 1837): the browser's own mobile flag where it has
 * one, otherwise its user agent. **Never the window's width**: a desk browser in
 * a narrow window is a computer, and Cockpit on a phone's home screen is a
 * phone. A tablet asking for the desktop site reads as a computer, which is
 * what the source's own website then serves it.
 */
export function onAPhoneDevice(device: DeviceReading = typeof navigator === 'undefined' ? {} : navigator): boolean {
  const flag = device.userAgentData?.mobile;
  if (typeof flag === 'boolean') return flag;
  return /android.+mobile|iphone|ipod|windows phone/i.test(device.userAgent ?? '');
}

/**
 * The declared phone addresses where this is a phone, undefined on a computer:
 * what every surface passes on to ask where an Item opens, so it is decided
 * once, by the device, when the surface draws.
 */
export function phoneLinksOnThisDevice(declared: DeclaredPhoneLinks, device?: DeviceReading): DeclaredPhoneLinks {
  return declared && onAPhoneDevice(device) ? declared : undefined;
}
