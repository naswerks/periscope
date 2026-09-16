/**
 * PKCE (RFC 7636) and the callback's `state` — the two random values that make an authorization-code
 * exchange safe to run on a machine somebody else is also running code on.
 *
 * They defend different things and neither substitutes for the other. This is the sentence worth
 * reading twice, because "it does PKCE" is routinely taken to mean the whole callback is covered:
 *
 *   - The code verifier proves that whoever redeems the authorization code is the same party
 *     that requested it. It protects the code exchange.
 *   - The state proves that the callback this host received is the answer to the request this
 *     host made. It protects the callback itself.
 *
 * Why that matters acutely here, rather than as boilerplate. This host's whole premise is that
 * the agent runs as the same OS user as the host — it is why an 0600 token file is not a boundary
 * and why the gate has a credential-path denial. That same fact means any local process can
 * connect to the loopback listener this flow opens. Without `state`, such a process could hand this
 * host an authorization code of its own obtaining and have the host redeem it and cache the
 * resulting token. `state` is what makes that a named refusal instead of a silent substitution.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';

/**
 * The only challenge method this host will use.
 *
 * RFC 7636 also defines `plain`, where the challenge is the verifier. This host refuses it rather
 * than merely not offering it — an unused branch is one a later reader restores on a compatibility
 * report, and `plain` gives away the whole property to anyone who can observe the authorization
 * request.
 */
export const CODE_CHALLENGE_METHOD = 'S256';

/** 32 bytes, which is 43 base64url characters — the RFC's floor is 43 and its ceiling is 128. */
const ENTROPY_BYTES = 32;

export interface Pkce {
  readonly verifier: string;
  readonly challenge: string;
  readonly method: typeof CODE_CHALLENGE_METHOD;
}

/**
 * base64url, per RFC 4648 §5 — no padding, URL-safe alphabet.
 *
 * Hand-rolled from base64 rather than reached for by name: `Buffer`'s `base64url` encoding is
 * equivalent, but the transform is one line and stating it keeps this readable next to the RFC.
 */
function base64Url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A cryptographically random, URL-safe string.
 *
 * `randomBytes`, never `Math.random`. `Math.random` is seeded, predictable and explicitly not for
 * this; a predictable verifier or state defeats the property entirely while looking identical in
 * every test.
 */
export function randomUrlSafe(bytes: number = ENTROPY_BYTES): string {
  return base64Url(randomBytes(bytes));
}

/** A fresh verifier and its S256 challenge. */
export function createPkce(): Pkce {
  const verifier = randomUrlSafe();
  return { verifier, challenge: challengeFor(verifier), method: CODE_CHALLENGE_METHOD };
}

/** The S256 challenge for a verifier: base64url(SHA-256(ascii(verifier))). */
export function challengeFor(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier, 'ascii').digest());
}

/**
 * The `state` value for one authorization request.
 *
 * Same entropy source as the verifier and deliberately a separate value — reusing the verifier as
 * state would put it in a URL the browser and the provider both log, and the verifier is the one
 * that must never leave this process until the token exchange.
 */
export function createState(): string {
  return randomUrlSafe();
}

/**
 * Refuse a challenge method this host will not use.
 *
 * Exported so the refusal is reachable and testable, rather than being an `if` nobody can drive.
 */
export function requireS256(method: string): Result<typeof CODE_CHALLENGE_METHOD> {
  if (method !== CODE_CHALLENGE_METHOD) {
    return refuse(
      'pkce-method-unsupported',
      `code challenge method ${method} is refused; this host uses ${CODE_CHALLENGE_METHOD} only, and "plain" would put the verifier itself in the authorization request`,
    );
  }
  return ok(CODE_CHALLENGE_METHOD);
}

/**
 * Compare two `state` values without leaking their contents through timing.
 *
 * The length check is separate and deliberate: `timingSafeEqual` throws on unequal lengths, so
 * comparing lengths first is required rather than an optimisation. It leaks the length and nothing
 * else, which is the standard accepted residual.
 */
export function stateMatches(expected: string, received: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}
