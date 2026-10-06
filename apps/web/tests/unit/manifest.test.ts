import { describe, expect, it } from 'vitest';
import { ATTACHMENT_CONTENT_TYPES, SHARE_TARGET_PATH } from '@cockpit/shared';
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

  describe('the installed app offers itself in the share sheet for what an Attachment accepts, and for text and links', () => {
    const target = manifest.share_target;

    it('accepts every content type the Attachment allowlist accepts, and no other', () => {
      const files = [target?.params.files ?? []].flat();

      expect(files).toHaveLength(1);
      expect([...(files[0]?.accept ?? [])].sort()).toEqual([...ATTACHMENT_CONTENT_TYPES].sort());
    });

    it('takes a shared title, text and link as well as files', () => {
      expect(target?.params).toMatchObject({ title: 'title', text: 'text', url: 'url' });
    });

    it('sends what is shared to the share address as a form upload', () => {
      expect(target).toMatchObject({
        action: SHARE_TARGET_PATH,
        method: 'POST',
        enctype: 'multipart/form-data',
      });
    });
  });
});
