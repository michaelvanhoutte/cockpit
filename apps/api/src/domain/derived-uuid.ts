/**
 * A uuid that is the same every time for the same name - what makes a
 * redelivered push, a pulled check run again or an alarm firing twice a replay
 * rather than a second Item.
 *
 * Version 5's own construction (a digest with the version and variant bits set)
 * over SHA-256 rather than SHA-1: what `z.uuid()` and the store want is the
 * shape, and nothing here depends on which digest produced it.
 */
export async function derivedUuid(name: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(name)),
  );
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
