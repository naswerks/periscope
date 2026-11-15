/**
 * A fact's text member, held to the bound the codec holds it to. Text a runtime wrote (a task's summary,
 * its description, a path) can run past the bound, and a fact carrying it would be a frame the codec
 * refuses, so it is cut before it is sent.
 */
import { MAX_FACT_TEXT_LENGTH } from './frames.js';

/**
 * `value` cut to at most `MAX_FACT_TEXT_LENGTH` UTF-16 code units, never inside a surrogate pair, so the
 * result is within the bound whether a reader counts code units or code points, and never holds a lone
 * surrogate the cut made. A value within the bound is returned as it is.
 */
export function factText(value: string): string {
  if (value.length <= MAX_FACT_TEXT_LENGTH) return value;
  const last = value.charCodeAt(MAX_FACT_TEXT_LENGTH - 1);
  const splitsPair = last >= 0xd800 && last <= 0xdbff;
  return value.slice(0, splitsPair ? MAX_FACT_TEXT_LENGTH - 1 : MAX_FACT_TEXT_LENGTH);
}
