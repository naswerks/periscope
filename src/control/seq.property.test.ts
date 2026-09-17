/**
 * The seq tracker against a reference model: one number per session, in a Map.
 *
 * seq.test.ts pins the named behaviours. This runs random command sequences against both the
 * tracker and the map and checks after every step that the two agree on what has been issued,
 * what an inbound number means, and which sessions are still held.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import { propertyRuns } from '../test-support/property.js';

import { SeqTracker } from './seq.js';
import type { SessionCursor } from './frames.js';

/** The reference: the highest number issued or accepted per session. Absent means 0. */
type Model = Map<string, number>;

type Command = fc.Command<Model, SeqTracker>;

const SESSIONS = ['a', 'b', 'c'] as const;
const sessionArb = fc.constantFrom(...SESSIONS);

/** The tracker's view of the model, in the model's own shape. */
function cursorsOf(tracker: SeqTracker): [string, number][] {
  return tracker
    .cursors()
    .map((cursor): [string, number] => [cursor.sessionId, cursor.seq])
    .sort();
}

function assertAgrees(model: Readonly<Model>, tracker: SeqTracker): void {
  assert.deepEqual(cursorsOf(tracker), [...model.entries()].sort(), 'cursors diverged from the model');
  assert.equal(tracker.trackedSessions, model.size);
  for (const session of SESSIONS) assert.equal(tracker.last(session), model.get(session) ?? 0);
}

class Next implements Command {
  constructor(private readonly session: string) {}
  check(): boolean {
    return true;
  }
  run(model: Model, tracker: SeqTracker): void {
    const expected = (model.get(this.session) ?? 0) + 1;
    assert.equal(tracker.next(this.session), expected, 'next is not model + 1');
    model.set(this.session, expected);
    assertAgrees(model, tracker);
  }
  toString(): string {
    return `next(${this.session})`;
  }
}

class Accept implements Command {
  constructor(
    private readonly session: string,
    private readonly seq: number,
  ) {}
  check(): boolean {
    return true;
  }
  run(model: Model, tracker: SeqTracker): void {
    const last = model.get(this.session) ?? 0;
    const check = tracker.accept(this.session, this.seq);
    if (this.seq === last + 1) {
      assert.deepEqual(check, { disposition: 'accept' });
      model.set(this.session, this.seq);
    } else if (this.seq <= last) {
      assert.deepEqual(check, { disposition: 'duplicate', seq: this.seq });
    } else {
      assert.deepEqual(check, { disposition: 'gap', expected: last + 1, received: this.seq });
    }
    assertAgrees(model, tracker);
  }
  toString(): string {
    return `accept(${this.session}, ${this.seq})`;
  }
}

class Adopt implements Command {
  constructor(private readonly cursors: readonly SessionCursor[]) {}
  check(): boolean {
    return true;
  }
  run(model: Model, tracker: SeqTracker): void {
    tracker.adopt(this.cursors);
    for (const cursor of this.cursors) model.set(cursor.sessionId, cursor.seq);
    assertAgrees(model, tracker);
  }
  toString(): string {
    return `adopt(${JSON.stringify(this.cursors)})`;
  }
}

class Forget implements Command {
  constructor(private readonly session: string) {}
  check(): boolean {
    return true;
  }
  run(model: Model, tracker: SeqTracker): void {
    tracker.forget(this.session);
    model.delete(this.session);
    assertAgrees(model, tracker);
    assert.equal(tracker.next(this.session), 1, 'a forgotten session did not restart at 1');
    tracker.forget(this.session);
  }
  toString(): string {
    return `forget(${this.session})`;
  }
}

const commandArbs: fc.Arbitrary<Command>[] = [
  sessionArb.map((session) => new Next(session)),
  fc.tuple(sessionArb, fc.integer({ min: 0, max: 12 })).map(([session, seq]) => new Accept(session, seq)),
  fc
    .array(fc.record({ sessionId: sessionArb, seq: fc.integer({ min: 0, max: 20 }) }), { maxLength: 3 })
    .map((cursors) => new Adopt(cursors)),
  sessionArb.map((session) => new Forget(session)),
];

test('the tracker agrees with a per-session counter under any sequence of next, accept, adopt and forget', () => {
  fc.assert(
    fc.property(fc.commands(commandArbs, { size: '+1' }), (commands) => {
      fc.modelRun(() => ({ model: new Map<string, number>(), real: new SeqTracker() }), commands);
    }),
    propertyRuns(),
  );
});

test("an inbound number is accepted exactly when it is the model's next, and only then does the cursor move", () => {
  fc.assert(
    fc.property(fc.array(fc.integer({ min: 0, max: 8 }), { maxLength: 30 }), (numbers) => {
      const tracker = new SeqTracker();
      let last = 0;
      for (const seq of numbers) {
        const before = tracker.last('s');
        const check = tracker.accept('s', seq);
        assert.equal(check.disposition === 'accept', seq === last + 1);
        if (check.disposition === 'accept') last = seq;
        else assert.equal(tracker.last('s'), before, 'a non-accept moved the cursor');
      }
      assert.equal(tracker.last('s'), last);
    }),
    propertyRuns(),
  );
});
