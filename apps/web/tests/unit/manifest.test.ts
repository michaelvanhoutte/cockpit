import { describe, expect, it } from 'vitest';
import { manifest } from '../../manifest';

/**
 * L1: the OS menu that shows the shortcut is outside any browser test, so what
 * is held is the manifest the build emits.
 */
describe('Capture', () => {
  it('the installed app offers a Capture shortcut to /capture, with the app icon', () => {
    const capture = manifest.shortcuts?.find((s) => s.name === 'Capture');

    expect(capture?.url).toBe('/capture');
    expect(capture?.icons?.map((i) => i.src)).toEqual(manifest.icons?.map((i) => i.src));
  });

  it('the installed app offers a Car capture shortcut to /capture/car beside Capture', () => {
    const names = manifest.shortcuts?.map((s) => s.name);
    const car = manifest.shortcuts?.find((s) => s.name === 'Car capture');

    expect(names).toEqual(['Capture', 'Car capture']);
    expect(car?.url).toBe('/capture/car');
    expect(car?.icons?.map((i) => i.src)).toEqual(manifest.icons?.map((i) => i.src));
  });
});
