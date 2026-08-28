/**
 * Client-generated IDs (architecture §4.2): UUIDv7 so IDs sort by creation time.
 * Runs identically in the browser, Workers, and Node (all expose WebCrypto).
 */
// This package compiles against pure ES libs (no DOM, no workers-types), so the
// one WebCrypto global all target runtimes share is declared here minimally.
declare const crypto: { getRandomValues<T extends ArrayBufferView>(array: T): T };

export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  // 48-bit big-endian millisecond timestamp
  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now / 2 ** 24) & 0xff;
  bytes[3] = (now / 2 ** 16) & 0xff;
  bytes[4] = (now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;

  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The creation time a UUIDv7 carries in its first 48 bits, in epoch milliseconds.
 * Returns null for anything that is not a UUIDv7, so a caller that reads an ID
 * from storage or a wire payload does not have to trust it is well-formed.
 */
export function uuidv7Timestamp(id: string): number | null {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return null;
  }

  const hex = id.slice(0, 13).replace('-', '');
  return Number.parseInt(hex, 16);
}
