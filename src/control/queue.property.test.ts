/**
 * The bounded queue against a reference model: a list of entries in arrival order, each pending
 * or written, with the eviction ladder restated in a dozen lines.
 *
 * queue.test.ts pins the named behaviours. This runs random command sequences at small capacities,
 * where the ladder is reached constantly, and checks the queue's every answer and every published
 * statistic against the model after each step.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import { propertyRuns } from '../test-support/property.js';

import { BoundedFrameQueue } from './queue.js';
import type { SessionFrame, SessionPayload } from './frames.js';
import { isDroppable } from './frames.js';

const AT = '2026-01-01T00:00:00.000Z';

interface ModelEntry {
  readonly id: number;
  readonly session: string;
  readonly droppable: boolean;
  written: boolean;
  seq: number | null;
}

interface Model {
  readonly capacity: number;
  readonly entries: ModelEntry[];
  readonly lastSeq: Map<string, number>;
  nextId: number;
}

/** The queue plus the stamper the link would hand it: a dense per-session counter. */
interface Real {
  readonly queue: BoundedFrameQueue;
  readonly stamp: (sessionId: string, at: string, payload: SessionPayload) => SessionFrame;
}

type Command = fc.Command<Model, Real>;

const SESSIONS = ['a', 'b'] as const;
const sessionArb = fc.constantFrom(...SESSIONS);

const frameId = (frame: SessionFrame): string => `${frame.sessionId}/${frame.seq}`;
const entryId = (entry: ModelEntry): string => `${entry.session}/${entry.seq}`;
const writtenIds = (queue: BoundedFrameQueue): string[] => queue.writtenFrames().map(frameId);

function payloadFor(id: number, droppable: boolean): SessionPayload {
  return droppable ? { kind: 'session_delta', body: { id } } : { kind: 'session_update', body: { id } };
}

/** Every invariant that must hold between commands. */
function assertAgrees(model: Readonly<Model>, real: Real): void {
  const stats = real.queue.stats;
  const written = real.queue.writtenFrames();

  assert.ok(stats.depth <= stats.capacity, 'depth exceeded capacity');
  assert.equal(stats.capacity, model.capacity);
  assert.equal(stats.depth, model.entries.length, 'depth diverged from the model');
  assert.equal(stats.pendingDepth, model.entries.filter((entry) => !entry.written).length);
  assert.equal(stats.depth, stats.pendingDepth + written.length, 'depth is not pending plus written');
  assert.equal(
    real.queue.hasPending,
    model.entries.some((entry) => !entry.written),
  );

  assert.deepEqual(
    written.map(frameId),
    model.entries.filter((entry) => entry.written).map(entryId),
    "the written frames are not the model's, in order",
  );
  for (const session of SESSIONS) {
    const seqs = written.filter((frame) => frame.sessionId === session).map((frame) => frame.seq);
    for (let index = 1; index < seqs.length; index += 1) {
      assert.ok(
        (seqs[index] as number) > (seqs[index - 1] as number),
        `seqs for ${session} are not strictly increasing: ${seqs.join(', ')}`,
      );
    }
    assert.equal(real.queue.retainedFor(session), seqs.length);
  }
}

class Push implements Command {
  constructor(
    private readonly session: string,
    private readonly droppable: boolean,
  ) {}
  check(): boolean {
    return true;
  }
  run(model: Model, real: Real): void {
    const before = writtenIds(real.queue);
    const id = model.nextId;
    model.nextId += 1;
    const pushed = real.queue.push(this.session, AT, payloadFor(id, this.droppable));
    const entry: ModelEntry = {
      id,
      session: this.session,
      droppable: this.droppable,
      written: false,
      seq: null,
    };

    if (model.entries.length < model.capacity) {
      assert.ok(pushed.ok, 'refused below capacity');
      assert.equal(pushed.value.evicted, null);
      model.entries.push(entry);
    } else if (this.droppable) {
      assert.equal(pushed.ok, false, 'a droppable was admitted at capacity');
      if (!pushed.ok) assert.equal(pushed.refusal.reason, 'queue-dropped-droppable');
    } else {
      const victim = model.entries.findIndex((held) => !held.written && held.droppable);
      if (victim >= 0) {
        const evicted = model.entries[victim] as ModelEntry;
        assert.ok(pushed.ok, 'an undroppable was refused with a pending droppable to evict');
        assert.deepEqual(pushed.value.evicted, { sessionId: evicted.session, kind: 'session_delta' });
        model.entries.splice(victim, 1);
        model.entries.push(entry);
      } else {
        assert.equal(pushed.ok, false, 'an undroppable was admitted with nothing to evict');
        if (!pushed.ok) assert.equal(pushed.refusal.reason, 'queue-overflow-undroppable');
      }
    }

    assert.deepEqual(writtenIds(real.queue), before, 'a push changed the written set');
    assertAgrees(model, real);
  }
  toString(): string {
    return `push(${this.session}, ${this.droppable ? 'delta' : 'update'})`;
  }
}

class StampNext implements Command {
  check(): boolean {
    return true;
  }
  run(model: Model, real: Real): void {
    const before = writtenIds(real.queue);
    const frame = real.queue.stampNext(real.stamp);
    const oldest = model.entries.find((entry) => !entry.written);

    if (oldest === undefined) {
      assert.equal(frame, null, 'stamped with nothing pending');
    } else {
      assert.ok(frame !== null, 'nothing stamped with an entry pending');
      const seq = (model.lastSeq.get(oldest.session) ?? 0) + 1;
      model.lastSeq.set(oldest.session, seq);
      oldest.written = true;
      oldest.seq = seq;
      assert.equal(frame.sessionId, oldest.session, 'stamped out of push order');
      assert.equal(frame.seq, seq);
      assert.deepEqual(
        (frame.payload as { body?: unknown }).body,
        { id: oldest.id },
        'stamped a different entry than the oldest pending',
      );
      assert.equal(isDroppable(frame.payload.kind), oldest.droppable);
    }

    const after = writtenIds(real.queue);
    assert.ok(
      before.every((id) => after.includes(id)),
      'a stamp removed a written frame',
    );
    assertAgrees(model, real);
  }
  toString(): string {
    return 'stampNext()';
  }
}

class PruneUpTo implements Command {
  constructor(
    private readonly session: string,
    private readonly seq: number,
  ) {}
  check(): boolean {
    return true;
  }
  run(model: Model, real: Real): void {
    const removed = real.queue.pruneUpTo(this.session, this.seq);
    const keep = model.entries.filter(
      (entry) => !(entry.written && entry.session === this.session && (entry.seq as number) <= this.seq),
    );
    assert.equal(removed, model.entries.length - keep.length);
    model.entries.splice(0, model.entries.length, ...keep);
    assertAgrees(model, real);
  }
  toString(): string {
    return `pruneUpTo(${this.session}, ${this.seq})`;
  }
}

class Forget implements Command {
  constructor(private readonly session: string) {}
  check(): boolean {
    return true;
  }
  run(model: Model, real: Real): void {
    const before = writtenIds(real.queue);
    const removed = real.queue.forget(this.session);
    const keep = model.entries.filter((entry) => entry.written || entry.session !== this.session);
    assert.equal(removed, model.entries.length - keep.length);
    model.entries.splice(0, model.entries.length, ...keep);
    assert.deepEqual(writtenIds(real.queue), before, 'forget changed the written set');
    assertAgrees(model, real);
  }
  toString(): string {
    return `forget(${this.session})`;
  }
}

class ReleaseSession implements Command {
  constructor(private readonly session: string) {}
  check(): boolean {
    return true;
  }
  run(model: Model, real: Real): void {
    const written = real.queue.releaseSession(this.session);
    const keep = model.entries.filter((entry) => entry.session !== this.session);
    const gone = model.entries.filter((entry) => entry.session === this.session);
    assert.equal(written, gone.filter((entry) => entry.written).length);
    model.entries.splice(0, model.entries.length, ...keep);
    assertAgrees(model, real);
  }
  toString(): string {
    return `releaseSession(${this.session})`;
  }
}

const commandArbs: fc.Arbitrary<Command>[] = [
  fc.tuple(sessionArb, fc.boolean()).map(([session, droppable]) => new Push(session, droppable)),
  fc.constant(new StampNext()),
  fc.tuple(sessionArb, fc.integer({ min: 0, max: 6 })).map(([session, seq]) => new PruneUpTo(session, seq)),
  sessionArb.map((session) => new Forget(session)),
  sessionArb.map((session) => new ReleaseSession(session)),
];

function realQueue(capacity: number): Real {
  const last = new Map<string, number>();
  return {
    queue: new BoundedFrameQueue(capacity),
    stamp: (sessionId, at, payload) => {
      const seq = (last.get(sessionId) ?? 0) + 1;
      last.set(sessionId, seq);
      return { frame: 'session', sessionId, seq, at, payload };
    },
  };
}

test('the queue agrees with the model under any sequence of push, stamp, prune, forget and release', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 4 }),
      fc.commands(commandArbs, { size: '+1' }),
      (capacity, commands) => {
        fc.modelRun(
          () => ({
            model: { capacity, entries: [], lastSeq: new Map<string, number>(), nextId: 1 },
            real: realQueue(capacity),
          }),
          commands,
        );
      },
    ),
    propertyRuns(),
  );
});

test('a full queue holding nothing droppable refuses every undroppable by name, and stays full', () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 5 }), fc.integer({ min: 1, max: 5 }), (capacity, extra) => {
      const real = realQueue(capacity);
      for (let index = 0; index < capacity; index += 1)
        assert.ok(real.queue.push('a', AT, payloadFor(index, false)).ok);
      for (let index = 0; index < extra; index += 1) {
        const pushed = real.queue.push('b', AT, payloadFor(100 + index, false));
        assert.equal(pushed.ok, false);
        if (!pushed.ok) assert.equal(pushed.refusal.reason, 'queue-overflow-undroppable');
      }
      assert.equal(real.queue.stats.depth, capacity);
      assert.equal(real.queue.stats.refusedUndroppable, extra);
    }),
    propertyRuns(),
  );
});
