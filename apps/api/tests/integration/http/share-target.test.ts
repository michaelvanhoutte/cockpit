import { describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';

/**
 * L2 through `SELF.fetch`, because the Worker answering the share address only
 * holds against the real routing: the address has to be one the Worker is
 * reached on (`run_worker_first`, apps/api/wrangler.jsonc) and one the sign-in
 * gate does not stand in front of. The page that then says so is
 * apps/web/tests/unit/pages/CapturePage.test.tsx.
 */
describe('Capture', () => {
  describe('a share the app cannot receive says so', () => {
    it('redirects a POST reaching the Worker to Capture with the "couldn\'t receive" signal, without a sign-in', async () => {
      const form = new FormData();
      form.set('text', 'Worth a read');
      form.set('files', new File(['png'], 'photo.png', { type: 'image/png' }));

      const answer = await SELF.fetch('http://cockpit.test/share-target', {
        method: 'POST',
        body: form,
        redirect: 'manual',
      });

      expect(answer.status).toBe(303);
      expect(answer.headers.get('location')).toBe('http://cockpit.test/capture?share=failed');
    });

    it('sends a visit by address to Capture, with no signal', async () => {
      const answer = await SELF.fetch('http://cockpit.test/share-target', { redirect: 'manual' });

      expect(answer.status).toBe(303);
      expect(answer.headers.get('location')).toBe('http://cockpit.test/capture');
    });
  });
});
