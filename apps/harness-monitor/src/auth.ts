const encoder = new TextEncoder();

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

/**
 * Whether two keys are equal, in time that does not depend on where they first
 * differ: both are hashed to the same length, then every byte is compared.
 */
export async function sameKey(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a[i]! ^ b[i]!;
  return difference === 0;
}

export type WriteCheck = 'allowed' | 'unconfigured' | 'refused';

/** Whether a request may write: it must carry `Authorization: Bearer <the write key>`. */
export async function checkWriteKey(header: string | null, configured: string | undefined): Promise<WriteCheck> {
  if (!configured) return 'unconfigured';
  const match = /^Bearer (.+)$/.exec(header ?? '');
  if (!match) return 'refused';
  return (await sameKey(match[1]!, configured)) ? 'allowed' : 'refused';
}
