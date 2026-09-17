/**
 * What is persisted, and the port that persists it.
 *
 * The shape and its validation live here, not with the filesystem, and the dependency direction
 * is the reason: `host/` may import this, and this may never import `host/`. Reading a cache is two
 * jobs — getting bytes off a disk, and deciding whether what they say is usable — and only the
 * first needs a machine. Keeping the second here means every malformed-cache branch is drivable
 * without writing a file.
 */
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import type { AuthProtocol } from './device-code.js';
import type { TokenSet } from './token.js';

/**
 * The persisted record.
 *
 * `authority` and `clientId` ride along so a cache minted against one provider is never presented
 * to another — a re-pointed host discards rather than replays, which matters because the token
 * would otherwise be sent to an audience it was not issued for. `protocol` exists for the
 * protocol-mismatch guard: material minted by one flow is discarded rather than refreshed when the
 * host is configured for the other.
 */
export interface CachedTokens {
  readonly tokens: TokenSet;
  readonly protocol: AuthProtocol;
  readonly authority: string;
  readonly clientId: string;
}

/**
 * The port the credential holds.
 *
 * An interface rather than the concrete file cache so the credential's whole decision surface —
 * expired, re-pointed, wrong protocol, corrupt — is testable with an in-memory double, and so an
 * embedder with its own secret storage can supply one without this package growing an opinion
 * about keychains.
 */
export interface TokenStore {
  read(): Result<CachedTokens>;
  write(cached: CachedTokens): Result<unknown>;
  clear(): void;
}

/** Validate a parsed cache into the shape the rest of the host relies on. */
export function readCachedTokens(parsed: unknown): Result<CachedTokens> {
  if (typeof parsed !== 'object' || parsed === null) {
    return refuse('credential-cache-unreadable', 'the token cache is not a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const tokens = record['tokens'];
  const protocol = record['protocol'];
  const authority = record['authority'];
  const clientId = record['clientId'];

  if (typeof tokens !== 'object' || tokens === null) {
    return refuse('credential-cache-unreadable', 'the token cache carries no tokens object');
  }
  const tokenRecord = tokens as Record<string, unknown>;
  const accessToken = tokenRecord['accessToken'];
  const expiresAt = tokenRecord['expiresAt'];

  if (typeof accessToken !== 'string' || accessToken === '' || typeof expiresAt !== 'number') {
    return refuse(
      'credential-cache-unreadable',
      'the cached token has no accessToken or no numeric expiresAt',
    );
  }
  if (protocol !== 'loopback' && protocol !== 'device-code') {
    return refuse(
      'credential-cache-unreadable',
      'the token cache does not say which flow minted it, so it cannot be safely refreshed',
    );
  }
  if (typeof authority !== 'string' || authority === '' || typeof clientId !== 'string' || clientId === '') {
    return refuse(
      'credential-cache-unreadable',
      'the token cache does not record the authority and client it was minted for',
    );
  }

  const refreshToken = tokenRecord['refreshToken'];
  const tokenType = tokenRecord['tokenType'];
  const scope = tokenRecord['scope'];

  return ok({
    tokens: {
      accessToken,
      refreshToken: typeof refreshToken === 'string' && refreshToken !== '' ? refreshToken : null,
      expiresAt,
      tokenType: typeof tokenType === 'string' && tokenType !== '' ? tokenType : 'Bearer',
      scope: typeof scope === 'string' ? scope : null,
    },
    protocol,
    authority,
    clientId,
  });
}
