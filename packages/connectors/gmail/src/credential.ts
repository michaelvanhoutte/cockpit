/**
 * What the host seals for a Gmail connection is the token response as Google
 * issued it, as one JSON string under `credential` - the only shape this
 * connector reads. Nothing of a connection made before Gmail was a connector is
 * migrated, so every one reconnects and arrives here.
 *
 * Google's answer carries `expires_in`, seconds from when it was issued, and
 * nothing says when that was. So a credential never refreshed here holds no
 * expiry and is refreshed before it is used; one this connector refreshed holds
 * `expires_at`, an absolute time it adds to what it hands back.
 */

/** What an opened Gmail credential holds. */
export interface GmailCredential {
  readonly refreshToken: string;
  readonly accessToken: string | null;
  /** When the access token lapses, or null where it is not known. */
  readonly expiresAt: string | null;
  /** Everything else Google sent, kept as it came so a refresh hands back what it was given. */
  readonly rest: Readonly<Record<string, unknown>>;
}

/** The credential the host opened, read - or null for one holding no refresh token. */
export function credentialIn(opened: Record<string, string>): GmailCredential | null {
  try {
    const parsed: unknown = JSON.parse(opened.credential ?? '');
    if (!parsed || typeof parsed !== 'object') return null;
    const { refresh_token, access_token, expires_at, ...rest } = parsed as Record<string, unknown>;
    if (typeof refresh_token !== 'string' || !refresh_token) return null;
    return {
      refreshToken: refresh_token,
      accessToken: typeof access_token === 'string' && access_token ? access_token : null,
      expiresAt: typeof expires_at === 'string' && expires_at ? expires_at : null,
      rest,
    };
  } catch {
    return null;
  }
}

/**
 * The refresh token to hand back to Google on disconnecting: the generic
 * credential's, or - for a connection made before Gmail was a connector and
 * never reconnected - the one the core sealed as `refreshToken`, so its grant
 * is cancelled too (issue 944). Read for revoking alone: nothing else of that
 * shape is used.
 */
export function refreshTokenToRevoke(opened: Record<string, string>): string | null {
  const held = credentialIn(opened);
  if (held) return held.refreshToken;
  try {
    const parsed: unknown = JSON.parse(opened.credential ?? '');
    const { refreshToken } = (parsed ?? {}) as Record<string, unknown>;
    return typeof refreshToken === 'string' && refreshToken ? refreshToken : null;
  } catch {
    return null;
  }
}

/**
 * How long before it lapses an access token is no longer used: a run that
 * starts on a token with seconds left would have it refused halfway.
 */
const ACCESS_TOKEN_MARGIN_MS = 60_000;

/** The held access token where it will last the run, or null where it has to be refreshed first. */
export function usableAccessToken(credential: GmailCredential, now: Date): string | null {
  if (!credential.accessToken || !credential.expiresAt) return null;
  const lapses = Date.parse(credential.expiresAt);
  return Number.isFinite(lapses) && lapses - ACCESS_TOKEN_MARGIN_MS > now.getTime() ? credential.accessToken : null;
}

/**
 * The credential after Google answered a refresh: the new access token and when
 * it lapses, beside the refresh token it was refreshed with - Google does not
 * rotate it, and it is kept where the answer carries none. Null for an answer
 * holding no access token.
 */
export function credentialRefreshed(credential: GmailCredential, answer: unknown, now: Date): GmailCredential | null {
  if (!answer || typeof answer !== 'object') return null;
  const { access_token: accessToken, expires_in: expiresIn, refresh_token: refreshToken } = answer as Record<
    string,
    unknown
  >;
  if (typeof accessToken !== 'string' || !accessToken) return null;
  const lasts = typeof expiresIn === 'number' && expiresIn > 0 ? expiresIn : 3600;
  return {
    refreshToken: typeof refreshToken === 'string' && refreshToken ? refreshToken : credential.refreshToken,
    accessToken,
    expiresAt: new Date(now.getTime() + lasts * 1000).toISOString(),
    rest: credential.rest,
  };
}

/** A credential in the shape the host seals: `credentialIn` reads it back. */
export function sealable(credential: GmailCredential): Record<string, string> {
  return {
    credential: JSON.stringify({
      ...credential.rest,
      refresh_token: credential.refreshToken,
      access_token: credential.accessToken,
      expires_at: credential.expiresAt,
    }),
  };
}
