/**
 * The nouns this package is allowed to name things after — the Claude Agent SDK's own words.
 *
 * Every wire discriminator begins with one of these, which is what makes the naming rule
 * mechanically checkable instead of a style note: a payload kind naming a concept the SDK does not
 * have is a concept this layer should not be modelling.
 */
export const SDK_NOUNS = [
  'session',
  'message',
  'hook',
  'tool',
  'subagent',
  'turn',
  'result',
  'permission',
  'compaction',
] as const;

export type SdkNoun = (typeof SDK_NOUNS)[number];

/**
 * Nouns this package owns because the SDK has no concept for them: the outbound link itself, and
 * the out-of-band transfer that keeps bulk bytes off it. Kept separate from `SDK_NOUNS` so the
 * distinction stays visible: these are the words this package invented rather than borrowed.
 */
export const HOST_NOUNS = ['link', 'bulk'] as const;

export type HostNoun = (typeof HOST_NOUNS)[number];

const ALL_NOUNS: readonly string[] = [...SDK_NOUNS, ...HOST_NOUNS];

/**
 * A discriminator is `<noun>_<verb>` or `<noun>/<method>`. Returns the leading noun, or null when
 * the string does not start with a declared one.
 */
export function nounOf(discriminator: string): string | null {
  const head = discriminator.split(/[_/]/, 1)[0] ?? '';
  return ALL_NOUNS.includes(head) ? head : null;
}

export function isDeclaredNoun(value: string): boolean {
  return ALL_NOUNS.includes(value);
}
