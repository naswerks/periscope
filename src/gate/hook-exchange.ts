/**
 * The one exchange between a runtime's hook process and this host, over the host-local hook channel,
 * and the only two outputs the hook ever writes back to its runtime.
 *
 * The hook process connects, sends one request line and reads one answer line. The request carries the
 * session's token, which the host checks before deciding anything, and a fresh nonce. The answer's body
 * is a JSON string authenticated by an HMAC over the nonce and that exact string, keyed by the token, so
 * a process that answers on the channel's name without the token cannot say allow: the hook verifies the
 * answer before it believes it.
 *
 * Codex runs its hook fail-open on the hook's own failure: a timeout, a crash, an unparseable output or a
 * shape it does not support all let the call proceed. So the hook writes exactly one of two outputs, both
 * of which Codex honours: nothing at all (the call proceeds) or a deny with a non-empty reason (it is
 * blocked). An allow is never written explicitly, because an allow without rewritten input is a shape
 * Codex refuses, and a refused output proceeds.
 *
 * This module is imported by the hook process on every tool call, so it imports nothing but the HMAC.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** The exchange's version, on both lines. A line of another version is refused. */
export const HOOK_EXCHANGE_VERSION = 1;

/** The largest request the hook sends and the host reads: the event a runtime hands its hook, whole. */
export const MAX_HOOK_INPUT_BYTES = 8 * 1024 * 1024;

/** The longest reason the hook writes back; a longer one is cut and marked. */
export const MAX_HOOK_REASON_LENGTH = 4_000;

/** The channel's address, set host-side in the runtime's environment. */
export const HOOK_CHANNEL_VARIABLE = 'PERISCOPE_HOOK_CHANNEL';
/** The session's token, set host-side in the runtime's environment and kept out of its tools' shell. */
export const HOOK_TOKEN_VARIABLE = 'PERISCOPE_HOOK_TOKEN';
/** How long the hook waits for the host's answer before denying, set host-side per session. */
export const HOOK_DEADLINE_VARIABLE = 'PERISCOPE_HOOK_DEADLINE_MS';

/**
 * The hook's timeout in Codex's hook configuration, in seconds. Codex enforces it, and on expiry the call
 * proceeds, so it is a backstop for a hook process that hung, never the deadline that decides anything:
 * the host's decision deadline expires first, then the hook's own deadline, then this.
 */
export const CODEX_HOOK_TIMEOUT_SECONDS = 120;

/**
 * The word a block opens with when no decision arrived in time: the same word the session's trace
 * names the expiry by, so a reader who looks the prefix up finds it.
 */
export const HOOK_EXPIRY_EVENT = 'hook_timed_out';

/** The margin between each deadline and the next: decision, then the hook's own, then Codex's timeout. */
export const HOOK_DEADLINE_MARGIN_MS = 5_000;

/** The hook's own deadline when none is stated, and the most it ever waits: inside Codex's timeout. */
export const MAX_HOOK_DEADLINE_MS = CODEX_HOOK_TIMEOUT_SECONDS * 1000 - HOOK_DEADLINE_MARGIN_MS;

/** What the hook asks. */
export interface HookRequest {
  readonly v: typeof HOOK_EXCHANGE_VERSION;
  /** `decide` asks about one call; `hello` asks only that the host answers. */
  readonly kind: 'decide' | 'hello';
  readonly token: string;
  readonly nonce: string;
  /** The runtime the hook runs inside, whose event shape `event` is. */
  readonly runtime: string;
  /** The event the runtime handed its hook, whole. Absent on `hello`. */
  readonly event?: unknown;
}

/** What the host answers about a call: proceed, possibly with rewritten input, or block with a reason. */
export type HookDecision =
  | { readonly allow: true; readonly updatedInput?: Record<string, unknown> }
  | { readonly allow: false; readonly reason: string };

/** What the host answers a `hello`. */
export interface HookHello {
  readonly ok: true;
  readonly version: string;
}

/** The answer line: the body as an exact JSON string, and its HMAC. */
export interface HookAnswerLine {
  readonly v: typeof HOOK_EXCHANGE_VERSION;
  readonly body: string;
  readonly mac: string;
}

/** The HMAC over the request's nonce and the answer's exact body, keyed by the session's token. */
export function hookAnswerMac(token: string, nonce: string, body: string): string {
  return createHmac('sha256', token).update(`${nonce}\n${body}`).digest('hex');
}

/** The answer line for `body`, authenticated for the request's nonce. */
export function hookAnswerLine(token: string, nonce: string, body: HookDecision | HookHello): string {
  const text = JSON.stringify(body);
  const line: HookAnswerLine = {
    v: HOOK_EXCHANGE_VERSION,
    body: text,
    mac: hookAnswerMac(token, nonce, text),
  };
  return `${JSON.stringify(line)}\n`;
}

/**
 * The body of an answer line whose HMAC verifies for this token and nonce, or null for any line that
 * does not: malformed, of another version, or not authenticated by the session's token.
 */
export function readHookAnswer(line: string, token: string, nonce: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const answer = parsed as Partial<Record<keyof HookAnswerLine, unknown>>;
  if (
    answer.v !== HOOK_EXCHANGE_VERSION ||
    typeof answer.body !== 'string' ||
    typeof answer.mac !== 'string'
  ) {
    return null;
  }
  const expected = Buffer.from(hookAnswerMac(token, nonce, answer.body), 'hex');
  const given = Buffer.from(answer.mac, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    return JSON.parse(answer.body) as unknown;
  } catch {
    return null;
  }
}

/** Whether two tokens are equal, in time that does not depend on where they differ. */
export function sameToken(given: string, expected: string): boolean {
  const left = Buffer.from(given, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The hook's output for a block: Codex's `PreToolUse` deny, with every key Codex declares and no other,
 * and a reason that is never empty. Non-ASCII characters are escaped so no console encoding between the
 * hook and its runtime can change the bytes.
 */
export function hookDenyOutput(reason: string): string {
  const stated = reason.trim() === '' ? 'the host refused this call and gave no reason' : reason;
  const bounded =
    stated.length > MAX_HOOK_REASON_LENGTH
      ? `${stated.slice(0, MAX_HOOK_REASON_LENGTH)}...[truncated]`
      : stated;
  const json = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: bounded,
    },
  });
  return json.replace(
    /[\u007f-￿]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/**
 * The hook's output for an answer body: empty for an allow it can carry out as asked, the deny for
 * everything else. An allow with rewritten input is a deny here, because the hook can only let a call
 * proceed as asked or block it; anything the hook does not recognise is a deny too.
 */
export function hookOutputFor(body: unknown): string {
  if (typeof body !== 'object' || body === null) return hookDenyOutput('the host answered with no decision');
  const decision = body as Partial<Record<string, unknown>>;
  if (decision['allow'] === true) {
    if (decision['updatedInput'] === undefined) return '';
    return hookDenyOutput('the host allowed this call with rewritten input, which this hook cannot apply');
  }
  if (decision['allow'] === false && typeof decision['reason'] === 'string')
    return hookDenyOutput(decision['reason']);
  return hookDenyOutput('the host answered with a decision this hook does not recognise');
}

/** The hook's own deadline from its environment: the stated value inside the bound, else the bound. */
export function hookDeadlineMs(stated: string | undefined): number {
  const value = stated === undefined ? Number.NaN : Number(stated);
  if (!Number.isInteger(value) || value <= 0) return MAX_HOOK_DEADLINE_MS;
  return Math.min(value, MAX_HOOK_DEADLINE_MS);
}
