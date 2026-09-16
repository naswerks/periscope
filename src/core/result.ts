import type { Refusal, RefusalReason } from './refusal.js';
import { refusal } from './refusal.js';

/**
 * The return type of anything that can decline. There is no thrown-exception path for expected
 * failure — a caller cannot forget to handle a `Result` the way it can forget a `try`.
 */
export type Result<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly refusal: Refusal };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function refuse<T>(reason: RefusalReason, detail: string): Result<T> {
  return { ok: false, refusal: refusal(reason, detail) };
}

/** Narrow without destructuring, for call sites that only branch. */
export function isOk<T>(result: Result<T>): result is { ok: true; value: T } {
  return result.ok;
}

/** The value, or a fallback. For call sites where a refusal is genuinely uninteresting. */
export function valueOr<T>(result: Result<T>, fallback: T): T {
  return result.ok ? result.value : fallback;
}
