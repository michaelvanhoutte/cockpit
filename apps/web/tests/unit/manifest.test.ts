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
});
