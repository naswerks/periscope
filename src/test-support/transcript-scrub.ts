/**
 * A scrubber for a recorded agent transcript: it keeps the shape and drops the content.
 *
 * A transcript is the agent's messages, one JSON object each. What a replay test needs from it is
 * the shape and the figures: every member name the SDK's messages carry, every number, every boolean
 * and null, and the few words that say what a message is (its type, its model, its status). What
 * must not ride into a repository is everything else: prompt and reply text, tool inputs and outputs,
 * paths, names and secrets.
 *
 * So every string is replaced by a placeholder, `<member>-<n>`, except under the members in
 * `KEPT_MEMBERS`, whose values are vocabulary or opaque identifiers. The placeholder is injective per
 * member across the whole transcript: one string at one member is always the same placeholder, and
 * two different strings never share one. A reader comparing two values (is this init's receipt the
 * same as the last one's?) answers on the scrubbed transcript exactly as on the raw one.
 *
 * A tool's own payload (a `tool_use` block's `input`, a `tool_result` block's `content`, and a
 * message's `tool_use_result`) is the tool's, not the SDK's: its member names are the tool's own and
 * can say anything, so inside it every name becomes `key-<n>` and every string `text-<n>`. Numbers,
 * booleans and null survive there too.
 */

/** The members whose string values are kept: vocabulary, model ids, and opaque identifiers. */
export const KEPT_MEMBERS: ReadonlySet<string> = new Set([
  'type',
  'subtype',
  'role',
  'model',
  'stop_reason',
  'service_tier',
  'speed',
  'inference_geo',
  'permissionMode',
  'apiKeySource',
  'claude_code_version',
  'effort',
  'status',
  'task_type',
  'trigger',
  'terminal_reason',
  'costBasis',
  'provider',
  'canonicalModel',
  'uuid',
  'session_id',
  'parent_tool_use_id',
  'tool_use_id',
  'task_id',
  'id',
  'request_id',
]);

/** The member name a string inside a tool's own payload is placed under. */
export const PAYLOAD_TEXT = 'text';

/** The member name a key inside a tool's own payload is renamed under. */
export const PAYLOAD_KEY = 'key';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** One scrubber, for one transcript: its placeholders hold across every line it is given. */
export class TranscriptScrubber {
  readonly #placeholders = new Map<string, Map<string, string>>();

  /** One message, scrubbed. */
  scrub(message: Json): Json {
    return this.#scrub(message, null, false);
  }

  #placeholder(member: string, value: string): string {
    let byValue = this.#placeholders.get(member);
    if (byValue === undefined) {
      byValue = new Map();
      this.#placeholders.set(member, byValue);
    }
    let placed = byValue.get(value);
    if (placed === undefined) {
      placed = `${member}-${byValue.size + 1}`;
      byValue.set(value, placed);
    }
    return placed;
  }

  #scrub(value: Json, member: string | null, inPayload: boolean): Json {
    if (typeof value === 'string') {
      if (inPayload) return this.#placeholder(PAYLOAD_TEXT, value);
      if (member !== null && KEPT_MEMBERS.has(member)) return value;
      return this.#placeholder(member ?? 'value', value);
    }
    if (Array.isArray(value)) return value.map((item) => this.#scrub(item, member, inPayload));
    if (value === null || typeof value !== 'object') return value;

    const scrubbed: { [key: string]: Json } = {};
    for (const [key, item] of Object.entries(value)) {
      const name = inPayload ? this.#placeholder(PAYLOAD_KEY, key) : key;
      scrubbed[name] = this.#scrub(item, key, inPayload || isToolPayload(value, key));
    }
    return scrubbed;
  }
}

/** Whether `holder[key]` is a tool's own payload. */
function isToolPayload(holder: { [key: string]: Json }, key: string): boolean {
  if (key === 'tool_use_result') return true;
  if (key === 'input' && (holder['type'] === 'tool_use' || holder['type'] === 'server_tool_use')) return true;
  return key === 'content' && holder['type'] === 'tool_result';
}

/**
 * What in one scrubbed message is not in scrubbed shape: a string that is neither a placeholder for
 * its member nor a kept value, a kept value that holds a path, or a member name that holds one. Empty
 * for a message the scrubber wrote. `forbidden` is matched against every kept value and member name.
 */
export function scrubViolations(message: Json, forbidden: RegExp): string[] {
  const found: string[] = [];
  const visit = (value: Json, member: string | null, inPayload: boolean, path: string): void => {
    if (typeof value === 'string') {
      const placeholder = new RegExp(`^${escape(inPayload ? PAYLOAD_TEXT : (member ?? 'value'))}-\\d+$`);
      if (placeholder.test(value)) return;
      if (inPayload || member === null || !KEPT_MEMBERS.has(member)) {
        found.push(`${path}: "${value.slice(0, 40)}" is not a placeholder`);
      } else if (/[\\/]/.test(value) || forbidden.test(value)) {
        found.push(`${path}: the kept value "${value.slice(0, 40)}" holds a path or a forbidden word`);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, member, inPayload, `${path}[${index}]`));
      return;
    }
    if (value === null || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (inPayload && !/^key-\d+$/.test(key))
        found.push(`${path}.${key}: a payload member name is not a placeholder`);
      if (!inPayload && (/[\\/:\s]/.test(key) || forbidden.test(spaced(key)))) {
        found.push(`${path}.${key}: the member name holds a path or a forbidden word`);
      }
      visit(item, key, inPayload || isToolPayload(value, key), `${path}.${key}`);
    }
  };
  visit(message, null, false, '$');
  return found;
}

/** A member name as words, so a camelCase or snake_case name is matched word by word. */
function spaced(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ');
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
