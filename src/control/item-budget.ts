/**
 * The item budget: one conversation item, as JSON, takes at most `MAX_AGENT_ITEM_BYTES`.
 *
 * Every runtime's filler hands its items through `fitAgentItem` before they reach the wire, so an item
 * past the budget is cut here, once, by one rule, and says so in its `truncated`:
 *   - a text member (`text`, `detail`, `output`, a change's `diff`) is cut, the longest first, at a code
 *     point, so no character is split;
 *   - a tool call's `input` is never cut: a JSON object cut in half would read as a whole one with
 *     different arguments, so an input past the budget is left out (`input: null`);
 *   - a change list longer than a fact list may be is held to it, and, when every diff is already
 *     empty and the item still does not fit, its last entries are left out.
 * An item that fits is returned unchanged, its `truncated` as the filler set it.
 *
 * Pure, and free of any runtime: it measures with `TextEncoder`, as the codec does.
 */
import type { AgentItem, FileChangeEntry } from './frames.js';
import { MAX_AGENT_ITEM_BYTES, MAX_FACT_LIST_ENTRIES, MAX_FACT_TEXT_LENGTH } from './frames.js';

const UTF8 = new TextEncoder();

/** The bytes a value takes as JSON, as the codec counts them. */
export function agentItemBytes(item: unknown): number {
  return UTF8.encode(JSON.stringify(item) ?? '').length;
}

/** The bytes one string takes as a JSON string, quotes and escapes included. */
function jsonStringBytes(text: string): number {
  return UTF8.encode(JSON.stringify(text)).length;
}

/** `index`, moved back one when it would split a surrogate pair. */
function codePointBoundary(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index;
  const before = text.charCodeAt(index - 1);
  return before >= 0xd800 && before <= 0xdbff ? index - 1 : index;
}

/** The longest prefix of `text`, ending on a code point, whose JSON string form takes at most `maxBytes`. */
export function prefixWithin(text: string, maxBytes: number): string {
  if (jsonStringBytes(text) <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonStringBytes(text.slice(0, codePointBoundary(text, middle))) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, codePointBoundary(text, low));
}

/** One text member an item may be cut in: its value, and the item with that member replaced. */
interface TextSlot {
  readonly value: string;
  with(text: string): AgentItem;
}

/** Every non-empty text member of `item`, each able to give back the item with itself cut. */
function textSlots(item: AgentItem): TextSlot[] {
  switch (item.kind) {
    case 'turn':
      return item.detail === null || item.detail === ''
        ? []
        : [{ value: item.detail, with: (text) => ({ ...item, detail: text, truncated: true }) }];
    case 'user_text':
    case 'agent_text':
    case 'thinking':
    case 'plan':
    case 'notice':
      return item.text === ''
        ? []
        : [{ value: item.text, with: (text) => ({ ...item, text, truncated: true }) }];
    case 'tool_call':
      return [];
    case 'tool_result': {
      const slots: TextSlot[] = [];
      if (item.output !== null && item.output !== '') {
        slots.push({ value: item.output, with: (text) => ({ ...item, output: text, truncated: true }) });
      }
      for (const [index, change] of (item.changes ?? []).entries()) {
        if (change.diff === null || change.diff === '') continue;
        slots.push({
          value: change.diff,
          with: (text) => ({
            ...item,
            changes: (item.changes ?? []).map((entry, at) =>
              at === index ? { ...entry, diff: text } : entry,
            ),
            truncated: true,
          }),
        });
      }
      return slots;
    }
  }
}

/** A change's paths held to the fact text bound, which the codec holds every path to. */
function boundedChange(change: FileChangeEntry): { change: FileChangeEntry; cut: boolean } {
  const cut = (path: string | null): string | null =>
    path === null || path.length <= MAX_FACT_TEXT_LENGTH ? path : path.slice(0, MAX_FACT_TEXT_LENGTH);
  const path = cut(change.path) ?? '';
  const movePath = cut(change.movePath);
  return {
    change: { ...change, path, movePath },
    cut: path !== change.path || movePath !== change.movePath,
  };
}

/** The bounds a tool result's change list is held to before the byte budget: entries and paths. */
function boundedChanges(item: AgentItem): AgentItem {
  if (item.kind !== 'tool_result' || item.changes === null) return item;
  const kept = item.changes.slice(0, MAX_FACT_LIST_ENTRIES).map(boundedChange);
  const cut = item.changes.length > MAX_FACT_LIST_ENTRIES || kept.some((entry) => entry.cut);
  return cut ? { ...item, changes: kept.map((entry) => entry.change), truncated: true } : item;
}

/**
 * `item` within the item budget: unchanged when it fits, else cut by the rules in this file's header,
 * with `truncated` true.
 */
export function fitAgentItem(item: AgentItem): AgentItem {
  let fitted = boundedChanges(item);
  if (agentItemBytes(fitted) <= MAX_AGENT_ITEM_BYTES) return fitted;

  if (fitted.kind === 'tool_call' && fitted.input !== null) {
    fitted = { ...fitted, input: null, truncated: true };
    if (agentItemBytes(fitted) <= MAX_AGENT_ITEM_BYTES) return fitted;
  }

  // Each pass cuts the longest text member by exactly what the item is over, so one pass fits unless
  // that member cannot give up enough; the next pass then takes the next longest.
  for (let pass = textSlots(fitted).length; pass > 0; pass -= 1) {
    const over = agentItemBytes(fitted) - MAX_AGENT_ITEM_BYTES;
    if (over <= 0) return fitted;
    const slots = textSlots(fitted);
    const longest = slots.reduce<TextSlot | null>(
      (best, slot) => (best === null || slot.value.length > best.value.length ? slot : best),
      null,
    );
    if (longest === null) break;
    fitted = longest.with(prefixWithin(longest.value, jsonStringBytes(longest.value) - over));
  }

  // Every text member is spent; only a long change list can still be over.
  while (
    agentItemBytes(fitted) > MAX_AGENT_ITEM_BYTES &&
    fitted.kind === 'tool_result' &&
    fitted.changes !== null &&
    fitted.changes.length > 0
  ) {
    fitted = { ...fitted, changes: fitted.changes.slice(0, -1), truncated: true };
  }
  return fitted;
}
