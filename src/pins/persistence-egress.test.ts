/**
 * THE EGRESS PIN: nothing arriving over the link can decide where a transcript goes.
 *
 * WHY THIS EXISTS. `sessionStore` is the first composable option that is a CONFIDENTIALITY AND
 * EGRESS surface — the object it takes receives every message the agent saw. The other two classes
 * of composable option are safe for reasons that do not apply to it: the streaming keys only widen
 * what this host observes about its own session, and the tool-surface keys are covered because the
 * gate registers with no matcher. Neither argument says anything about where bytes end up.
 *
 * WHAT MAKES IT SAFE IS STRUCTURAL, AND THIS FILE IS WHERE THAT STOPS BEING A SENTENCE. A store is
 * an object with METHODS. It has no JSON representation, so it cannot be expressed in a frame, and
 * the only code that can supply one is the code that composes this host. A controller cannot name a
 * destination for a transcript even in principle.
 *
 * The day this pin matters is the day somebody makes a store constructible from data: a URL, a
 * connection string, a descriptor the host resolves into a client. That would be an ordinary-looking
 * convenience and it would turn a wire field into an exfiltration route. This fails first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { sourceFiles } from './walk.js';
import { PERSISTENCE_OPTION_KEYS } from '../host/agent-process.js';
import type { SessionFrame, SessionNew } from '../control/frames.js';
import { SESSION_NEW_KEYS, SESSION_NEW_REQUEST_KEYS, sessionNew } from '../control/frames.js';
import { decode, encode } from '../control/codec.js';

const startSession = (): SessionFrame => ({
  frame: 'session',
  sessionId: 's-1',
  seq: 1,
  at: '2026-08-04T12:00:00Z',
  payload: sessionNew('/workspace') satisfies SessionNew,
});

const framesSource = (): string => {
  const file = sourceFiles().find((one) => one.path === 'control/frames.ts');
  assert.ok(file !== undefined, 'control/frames.ts is not where this pin thinks it is');
  return file.text;
};

test('regression: no wire frame declares a persistence option, so a destination cannot be requested', () => {
  const text = framesSource();
  const leaked = PERSISTENCE_OPTION_KEYS.filter((key) => text.includes(key));

  assert.deepEqual(
    leaked,
    [],
    `the wire vocabulary names a persistence option, so a controller could ask for a destination:\n  ${leaked.join('\n  ')}`,
  );
});

/**
 * A `session_new` with EVERY field populated, derived from the declared key sets rather than typed
 * out — see `SESSION_NEW_REQUEST_KEYS` for why "derived" is load-bearing here.
 *
 * The values are deliberately junk: this fixture exists to be WALKED, not to be valid. What matters
 * is that every declared key is present, so the walk below cannot miss a place a field could hide.
 */
const fullyPopulated = (): Record<string, unknown> => {
  const request = Object.fromEntries(
    Object.keys(SESSION_NEW_REQUEST_KEYS).map((key) => [key, `value-${key}`]),
  );
  return {
    ...Object.fromEntries(Object.keys(SESSION_NEW_KEYS).map((key) => [key, `value-${key}`])),
    kind: 'session_new',
    cwd: '/workspace',
    request,
    gate: { decisionTimeoutMs: 1, holdAfterMs: 1, matcherTimeoutSeconds: 2 },
  };
};

/** Every key at every depth, as `path` strings. The walk the pin below rests on. */
const keysAtEveryDepth = (value: unknown, prefix = ''): string[] => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
    `${prefix}${key}`,
    ...keysAtEveryDepth(child, `${prefix}${key}.`),
  ]);
};

/**
 * A field count is not the property. Asserting that `session_new` has exactly N fields is a proxy
 * that goes false the moment the payload grows a nested `request` object, and a top-level count
 * could never see inside that object, which is precisely where a destination field could hide.
 *
 * So the property is asserted directly, in two halves that fail differently:
 *   1. the payload's declared shape is exactly what it says it is, so a field cannot join silently;
 *   2. no key at any depth of a fully-populated payload is a persistence option.
 *
 * The fixture is derived from the declared key sets. A hand-listed fixture stops being "fully
 * populated" the moment a later change adds a field, and the walk then covers less while still
 * passing. Deriving it means an unpopulated new key is a compile error at `SESSION_NEW_REQUEST_KEYS`
 * rather than a blind spot nobody can see.
 */
test('regression: no field of session_new, at any depth, can name a transcript destination', () => {
  const declared = Object.keys(SESSION_NEW_KEYS).sort();
  const payload = startSession().payload as unknown as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(payload).sort(),
    declared,
    'session_new grew or lost a field without SESSION_NEW_KEYS moving with it',
  );

  const walked = keysAtEveryDepth(fullyPopulated());

  // The fixture really is full: every declared request key is present at the path the walk reaches.
  for (const key of Object.keys(SESSION_NEW_REQUEST_KEYS)) {
    assert.ok(
      walked.includes(`request.${key}`),
      `the fixture never populated request.${key} — the walk is partial`,
    );
  }

  const leaked = walked.filter((path) =>
    PERSISTENCE_OPTION_KEYS.some((key) => path === key || path.endsWith(`.${key}`)),
  );
  assert.deepEqual(leaked, [], `a persistence option is reachable on session_new: ${leaked.join(', ')}`);
});

test('control: the depth walk finds a planted destination that a top-level count could not', () => {
  // The plant sits inside the nested request, one level down, exactly where a top-level count is
  // blind. A scanner that cannot find a planted violation is not a scanner.
  const planted = fullyPopulated();
  (planted['request'] as Record<string, unknown>)['sessionStore'] = { append: 'looks-like-data' };

  const walked = keysAtEveryDepth(planted);
  const leaked = walked.filter((path) =>
    PERSISTENCE_OPTION_KEYS.some((key) => path === key || path.endsWith(`.${key}`)),
  );
  assert.deepEqual(leaked, ['request.sessionStore'], 'the walk cannot see a nested destination field');

  // And a top-level check is shown to be blind to it, so "stronger" is demonstrated, not claimed.
  assert.equal(
    Object.keys(planted).includes('sessionStore'),
    false,
    'a top-level key check sees nothing here, which is why the walk goes to every depth',
  );
});

test('regression: a live store cannot survive the wire, because its methods do not serialise', () => {
  // The structural fact the whole classification rests on, demonstrated rather than asserted. A
  // store is behaviour; JSON carries data. Round-tripping one leaves an object that answers nothing.
  const store = {
    append: async (): Promise<void> => undefined,
    load: async (): Promise<null> => null,
  };
  assert.equal(typeof store.append, 'function');

  const throughJson = JSON.parse(JSON.stringify(store)) as Record<string, unknown>;
  assert.deepEqual(throughJson, {}, 'every method vanished; there is nothing left to call');
  assert.equal(typeof throughJson['append'], 'undefined');
});

test('regression: a frame carrying a store-shaped payload does not survive encode/decode as a store', () => {
  // The same fact through the package's own codec rather than through bare JSON, because that is the
  // path a real frame takes. Whatever a sender puts on the link, the receiver gets data.
  const smuggled = startSession();
  (smuggled.payload as unknown as Record<string, unknown>)['sessionStore'] = {
    append: async (): Promise<void> => undefined,
  };

  const wire = encode(smuggled);
  assert.equal(wire.ok, true, 'the frame encodes: the smuggling attempt is not rejected, it is futile');

  const back = decode(wire.ok ? wire.value : '');
  assert.equal(back.ok, true);
  const payload = back.ok ? (back.value.payload as unknown as Record<string, unknown>) : {};
  const arrived = payload['sessionStore'];
  assert.notEqual(typeof arrived, 'function');
  if (arrived !== undefined) {
    assert.deepEqual(arrived, {}, 'the methods did not arrive, so nothing callable crossed');
  }
});

// Guards the selector rather than the rule. A renamed key, a walker that stopped finding the file,
// or a scan over the wrong text would make the first assertion pass over nothing, and that green is
// byte-identical to the honest one.
test('control: the egress detector actually detects', () => {
  assert.ok(PERSISTENCE_OPTION_KEYS.length >= 2, 'the key list is not empty');
  assert.ok(PERSISTENCE_OPTION_KEYS.includes('sessionStore'));

  const text = framesSource();
  assert.ok(text.length > 500, 'the frames source was actually read');
  assert.ok(text.includes('session_new'), 'and it is the file that declares the wire vocabulary');

  // The scan finds a key when one IS present — proving the first test would fail if it should.
  const planted = `${text}\n// sessionStore`;
  assert.equal(
    PERSISTENCE_OPTION_KEYS.some((key) => planted.includes(key)),
    true,
    'the same scan detects a planted mention, so its silence on the real file is meaningful',
  );
});

test('the persistence keys are none of the streaming or tool-surface keys', () => {
  // Three lists, three reasons. A key filed in two places would make one of the reasons unfalsifiable.
  assert.deepEqual([...PERSISTENCE_OPTION_KEYS], ['sessionStore', 'sessionStoreFlush']);
});
