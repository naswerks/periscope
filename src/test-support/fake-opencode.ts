/**
 * An in-process stand-in for an opencode session's host process (`opencode-host.ts`) and the server it hosts,
 * for the opencode adapter's tests. It implements the relay's `ConnectOpencode`, never the SDK's own types, and
 * holds to what the pinned server was measured doing where the adapter's guarantees rest on it:
 * - The server's own reads answer from the configuration the adapter opened it with: every agent's rules end
 *   with the configuration's rules, the session's rules are the ones it was created with, the plugins are the
 *   runtime's own, the servers are the configuration's, the configuration is read from the adapter's directory,
 *   and the models are the configured provider's.
 * - A prompt is queued, delivered and run in order, one run at a time. Each call of a run announces itself
 *   (`session.tool.input.started`, `session.tool.called`). A call of a tool the adapter asked to have held
 *   (`gatedTools`) then waits on the adapter's answer before anything else: refused, it fails with the
 *   answer's words and raises nothing. A call that goes on asks once for each request it raises
 *   (`permission.asked`), and waits forever for the answer. A refused request fails the call with the words,
 *   and refuses every other request of its session still waiting, as the server does; an approved call
 *   succeeds.
 * - A run ends with its text, one model call's usage (`session.step.ended`) and `session.execution.succeeded`.
 * Every call the adapter makes is recorded, so a test reads back what was asked.
 */
import type { JsonObject, JsonValue } from '../control/frames.js';
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import type { ConnectOpencode, OpencodeConnectOptions } from '../host/opencode-relay.js';
import type { OpencodeRule } from '../host/opencode-sdk.js';
import type { ChildExit } from '../host/stdio-rpc.js';

/** One request a call raises. */
export interface FakeOpencodeRequest {
  readonly action: string;
  readonly resources?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** One call a run makes. */
export interface FakeOpencodeCall {
  readonly id: string;
  /** The tool's name, as the server announces it. */
  readonly name: string;
  readonly input?: Readonly<Record<string, unknown>>;
  /** The requests it raises, in order; one of its own name by default, none when empty. */
  readonly requests?: readonly FakeOpencodeRequest[];
  /** The text an approved call's result carries. */
  readonly output?: string;
  /** The session it runs in: a subagent's, by id; the session's own by default. */
  readonly session?: string;
  /** The model's provider ran it itself: it raises no request and the server does not run it. */
  readonly executed?: boolean;
  /** It runs until the test lets it go on (`release`), as a call that takes a long while does. */
  readonly waits?: boolean;
}

export interface FakeOpencodeOptions {
  readonly sessionId?: string;
  /** The calls a run makes, by its prompt. */
  readonly calls?: (prompt: string) => readonly FakeOpencodeCall[];
  readonly answer?: string;
  /** The cost each model call reports, in US dollars. */
  readonly cost?: number;
  /** Each run fails with this error instead of answering. */
  readonly runError?: { readonly type: string; readonly message: string };
  /** What the server's reads answer, in place of what the configuration says. */
  readonly sessionRules?: readonly OpencodeRule[];
  readonly agents?: readonly { readonly id: string; readonly permissions: readonly OpencodeRule[] }[];
  readonly saved?: readonly { readonly action: string; readonly resource: string }[];
  readonly plugins?: readonly { readonly id?: string; readonly source: { readonly type: string } }[];
  readonly servers?: readonly string[];
  readonly configEntries?: readonly { readonly type: string; readonly path?: string }[];
  readonly models?: readonly { readonly id: string; readonly providerID: string }[];
  /** The agent a resumed session reports. */
  readonly resumedAgent?: string;
  /** The open fails with these words. */
  readonly connectFailure?: string;
  /** Calls that are refused, by method, with these words. */
  readonly failing?: Readonly<Record<string, string>>;
  /** Calls that are never answered: each is refused once its deadline passes, as the transport refuses it. */
  readonly hanging?: readonly string[];
  /** The host process's id; null for one that never started. */
  readonly pid?: number | null;
  /** A call the server holds as soon as it is created, before the adapter has opened its session. */
  readonly heldAtConnect?: FakeOpencodeCall;
  /** Handed the function that lets a call that `waits` go on. */
  readonly release?: (resume: () => void) => void;
  /** Sessions an earlier process left in the database: each with the session that started it. */
  readonly earlierSessions?: readonly { readonly id: string; readonly parentID: string }[];
  /** Requests raised before the adapter read the stream: no event tells of them, the server lists them. */
  readonly waitingAtOpen?: readonly {
    readonly id: string;
    readonly sessionID: string;
    readonly action: string;
    readonly resources?: readonly string[];
    readonly callId?: string;
  }[];
  /** A request raised as soon as the server is created, before the adapter has opened its session. */
  readonly askedAtConnect?: { readonly id: string; readonly sessionID: string; readonly action: string };
}

/** What the fake recorded. */
export interface FakeOpencodeRecord {
  readonly connects: OpencodeConnectOptions[];
  /** Each open's configuration, parsed. */
  readonly configs: Record<string, unknown>[];
  readonly calls: { method: string; input: JsonObject }[];
  readonly replies: { requestID: string; decision: string; message?: string }[];
  /** Each call the server held before it ran, with the adapter's answer. */
  readonly held: { callId: string; allow: boolean }[];
  /** Each request raised outside a run that the adapter answered, with its answer. */
  readonly settled: { requestID: string; decision: string; message?: string }[];
  readonly lifecycle: string[];
  /** Send one event, as the server would. */
  emit(type: string, data: Record<string, unknown>): void;
  /** Start a subagent's session under the session, by the call that started it; its id. */
  spawn(callId: string, agent?: string): string;
  /** Raise one request as the server would, for any session, and settle with the adapter's answer. */
  ask(request: {
    id: string;
    sessionID: string;
    action: string;
    resources?: readonly string[];
    callId?: string;
  }): Promise<{ decision: string; message?: string }>;
  /** Have the transport drop a line of the host process's, as one too long to read is dropped. */
  dropLine(detail: string): void;
  /** Exit the host process, as if it died. */
  exit(code: number): void;
  /** End the event stream while the process lives. */
  streamEnd(detail: string): void;
  /** The calls of `method`, in order. */
  of(method: string): JsonObject[];
}

const DEFAULT_PLUGINS = [
  { id: 'opencode.tool.shell', source: { type: 'builtin' }, state: { status: 'active' } },
  { id: 'opencode.tool.edit', source: { type: 'builtin' }, state: { status: 'active' } },
  // This host's own pre-call gate, as the server lists a plugin it was created with.
  { id: 'periscope.gate', source: { type: 'sdk' }, state: { status: 'active' } },
];

/** A fake host process and what it records. */
export function fakeOpencode(options: FakeOpencodeOptions = {}): {
  connect: ConnectOpencode;
  record: FakeOpencodeRecord;
} {
  let events = 0;
  let children = 0;
  let live: OpencodeConnectOptions | null = null;
  let config: Record<string, unknown> = {};
  let exited: (exit: ChildExit) => void = () => undefined;
  const exitedPromise = new Promise<ChildExit>((resolve) => {
    exited = resolve;
  });
  let closed = false;
  // Each session's rules and agent, by id.
  const sessions = new Map<string, { rules: readonly OpencodeRule[]; agent: string }>();
  // Each request waiting on an answer, by its id.
  const waiting = new Map<
    string,
    { session: string; settle: (decision: string, message?: string) => void }
  >();
  let queue: Promise<void> = Promise.resolve();
  let steps = 0;

  const send = (type: string, data: Record<string, unknown>): void => {
    if (live === null || closed) return;
    events += 1;
    live.onEvent({ id: `evt_${events}`, type, data: data as JsonObject });
  };

  const record: FakeOpencodeRecord = {
    connects: [],
    configs: [],
    calls: [],
    replies: [],
    held: [],
    settled: [],
    lifecycle: [],
    emit: send,
    spawn(callId, agent = 'general') {
      children += 1;
      const id = `ses_child_${children}`;
      sessions.set(id, { rules: (config['permissions'] as OpencodeRule[] | undefined) ?? [], agent });
      send('session.created', { sessionID: id, parentID: options.sessionId ?? 'ses_main', agent });
      send('session.tool.progress', {
        sessionID: options.sessionId ?? 'ses_main',
        id: callId,
        metadata: { sessionID: id },
      });
      return id;
    },
    ask(request) {
      return new Promise((resolve) => {
        waiting.set(request.id, {
          session: request.sessionID,
          settle: (decision, message) => resolve({ decision, ...(message === undefined ? {} : { message }) }),
        });
        send('permission.asked', {
          id: request.id,
          sessionID: request.sessionID,
          action: request.action,
          resources: [...(request.resources ?? [])],
          metadata: {},
          source: { type: 'tool', messageID: 'msg_1', id: request.callId ?? `call_of_${request.id}` },
        });
      });
    },
    dropLine(detail) {
      live?.onRefusal?.({ reason: 'rpc-line-too-large', detail });
    },
    exit(code) {
      live?.onExit({ code, signal: null, error: null });
      exited({ code, signal: null, error: null });
    },
    streamEnd(detail) {
      live?.onStreamEnd(detail);
    },
    of(method) {
      return record.calls.filter((call) => call.method === method).map((call) => call.input);
    },
  };

  const configRules = (): readonly OpencodeRule[] =>
    (config['permissions'] as OpencodeRule[] | undefined) ?? [];

  const configModels = (): { id: string; providerID: string }[] => {
    const providers = (config['providers'] ?? {}) as Record<string, { models?: Record<string, unknown> }>;
    return Object.entries(providers).flatMap(([providerID, entry]) =>
      Object.keys(entry.models ?? {}).map((id) => ({ id, providerID })),
    );
  };

  /** Ask one request and wait for its answer. */
  const ask = (session: string, requestID: string, call: FakeOpencodeCall, request: FakeOpencodeRequest) =>
    new Promise<{ decision: string; message?: string }>((resolve) => {
      waiting.set(requestID, {
        session,
        settle: (decision, message) => resolve({ decision, ...(message === undefined ? {} : { message }) }),
      });
      send('permission.asked', {
        id: requestID,
        sessionID: session,
        action: request.action,
        resources: [...(request.resources ?? [])],
        metadata: { ...(request.metadata ?? {}) },
        source: { type: 'tool', messageID: 'msg_1', id: call.id },
      });
    });

  /** One call, as the server runs it. */
  const runCall = async (main: string, call: FakeOpencodeCall): Promise<void> => {
    const session = call.session ?? main;
    send('session.tool.input.started', { sessionID: session, id: call.id, name: call.name });
    send('session.tool.called', {
      sessionID: session,
      id: call.id,
      input: { ...(call.input ?? {}) },
      ...(call.executed === true ? { executed: true } : {}),
    });
    if (call.executed === true) {
      send('session.tool.success', { sessionID: session, id: call.id, executed: true, content: [] });
      return;
    }
    if (live?.gatedTools?.includes(call.name) === true) {
      const held =
        live.onHeldCall === undefined
          ? { allow: false, message: 'nothing answers a held call' }
          : await live.onHeldCall({
              tool: call.name,
              sessionID: session,
              callId: call.id,
              input: { ...(call.input ?? {}) } as JsonObject,
            });
      record.held.push({ callId: call.id, allow: held.allow });
      if (!held.allow) {
        send('session.tool.failed', {
          sessionID: session,
          id: call.id,
          error: { type: 'tool.error', message: held.message ?? 'refused' },
        });
        return;
      }
    } else live?.onBegan?.({ tool: call.name, sessionID: session, callId: call.id });
    if (call.waits === true) {
      await new Promise<void>((resolve) => options.release?.(resolve));
    }
    const requests = call.requests ?? [{ action: call.name }];
    let index = 0;
    for (const request of requests) {
      index += 1;
      const requestID = `per_${call.id}_${index}`;
      const answer = await ask(session, requestID, call, request);
      send('permission.replied', { sessionID: session, requestID, reply: answer.decision });
      if (answer.decision === 'reject') {
        // The server refuses every other request of the session still waiting, with the same words.
        for (const [other, entry] of [...waiting]) {
          if (entry.session !== session) continue;
          waiting.delete(other);
          send('permission.replied', { sessionID: session, requestID: other, reply: 'reject' });
          entry.settle('reject', answer.message);
        }
        send('session.tool.failed', {
          sessionID: session,
          id: call.id,
          error: { type: 'permission.rejected', message: answer.message ?? 'rejected' },
        });
        return;
      }
    }
    send('session.tool.success', {
      sessionID: session,
      id: call.id,
      content: [{ type: 'text', text: call.output ?? 'done' }],
    });
  };

  /** One prompt's run, after any run before it. */
  const run = (session: string, text: string, inbox: string): void => {
    queue = queue.then(async () => {
      send('session.inbox.delivered', { sessionID: session, inboxID: inbox });
      send('session.execution.started', { sessionID: session });
      const calls = options.calls?.(text) ?? [];
      await Promise.all(calls.map((call) => runCall(session, call)));
      if (options.runError !== undefined) {
        send('session.execution.failed', { sessionID: session, error: { ...options.runError } });
        return;
      }
      steps += 1;
      const step = `msg_${steps}`;
      const configured: Partial<Record<string, unknown>> =
        typeof config['model'] === 'object' && config['model'] !== null ? config['model'] : {};
      send('session.step.started', {
        sessionID: session,
        assistantMessageID: step,
        agent: sessions.get(session)?.agent ?? 'build',
        model: {
          id: typeof configured['model'] === 'string' ? configured['model'] : 'fake-model',
          providerID: typeof configured['providerID'] === 'string' ? configured['providerID'] : 'fake',
        },
      });
      send('session.text.ended', { sessionID: session, text: options.answer ?? 'done' });
      send('session.step.ended', {
        sessionID: session,
        assistantMessageID: step,
        tokens: { input: 120, output: 7, reasoning: 0, cache: { read: 20, write: 0 } },
        cost: options.cost ?? 0,
      });
      send('session.execution.succeeded', { sessionID: session });
    });
  };

  const info = (id: string): Record<string, unknown> => {
    const session = sessions.get(id);
    return {
      id,
      agent: session?.agent ?? 'build',
      permissions: [...(session?.rules ?? [])],
      location: { directory: live?.cwd ?? '' },
    };
  };

  let prompts = 0;
  const answer = (method: string, input: JsonObject): Record<string, unknown> | unknown[] | null => {
    const sessionID = typeof input['sessionID'] === 'string' ? input['sessionID'] : '';
    switch (method) {
      case 'model.list':
        return { data: [...(options.models ?? configModels())] };
      case 'session.create': {
        const id = options.sessionId ?? 'ses_main';
        const agent = typeof input['agent'] === 'string' ? input['agent'] : 'build';
        sessions.set(id, {
          rules: options.sessionRules ?? (input['permissions'] as OpencodeRule[] | undefined) ?? [],
          agent,
        });
        send('session.created', { sessionID: id, agent, model: input['model'] ?? null });
        return { ...info(id), ...(input['model'] === undefined ? {} : { model: input['model'] }) };
      }
      case 'session.get': {
        if (!sessions.has(sessionID)) {
          sessions.set(sessionID, {
            rules: options.sessionRules ?? configRules(),
            agent: options.resumedAgent ?? 'build',
          });
        }
        return info(sessionID);
      }
      case 'session.list':
        return {
          data: [
            ...[...sessions.keys()].map((id) => ({ id })),
            ...(options.earlierSessions ?? []).map((one) => ({ id: one.id, parentID: one.parentID })),
          ],
        };
      case 'permission.request.list':
        return {
          data: (options.waitingAtOpen ?? [])
            .filter((one) => waiting.has(one.id))
            .map((one) => ({
              id: one.id,
              sessionID: one.sessionID,
              action: one.action,
              resources: [...(one.resources ?? [])],
              metadata: {},
              source: { type: 'tool', messageID: 'msg_1', id: one.callId ?? `call_of_${one.id}` },
            })),
        };
      case 'session.fork': {
        const id = `${sessionID}-fork`;
        const from = sessions.get(sessionID);
        sessions.set(id, {
          rules: options.sessionRules ?? from?.rules ?? configRules(),
          agent: options.resumedAgent ?? from?.agent ?? 'build',
        });
        return info(id);
      }
      case 'session.prompt': {
        prompts += 1;
        const inbox = `inbox_${prompts}`;
        const text = typeof input['text'] === 'string' ? input['text'] : '';
        send('session.inbox.enqueued', {
          sessionID,
          inboxID: inbox,
          item: { type: 'user', payload: { text } },
        });
        run(sessionID, text, inbox);
        return { id: inbox };
      }
      case 'session.interrupt':
        return { interrupted: true };
      case 'session.switchAgent': {
        const session = sessions.get(sessionID);
        if (session !== undefined && typeof input['agent'] === 'string') session.agent = input['agent'];
        send('session.agent.selected', { sessionID, agent: input['agent'] ?? null });
        return null;
      }
      case 'session.switchModel':
        send('session.model.selected', { sessionID, model: input['model'] ?? null });
        return null;
      case 'session.environment':
      case 'session.remove':
        return null;
      case 'session.form.cancel':
        send('form.cancelled', { sessionID, formID: input['formID'] ?? null });
        return null;
      case 'permission.reply': {
        const requestID = typeof input['requestID'] === 'string' ? input['requestID'] : '';
        const decision = typeof input['decision'] === 'string' ? input['decision'] : '';
        const message = typeof input['message'] === 'string' ? input['message'] : undefined;
        record.replies.push({ requestID, decision, ...(message === undefined ? {} : { message }) });
        const entry = waiting.get(requestID);
        if (entry === undefined) throw new Error(`permission ${requestID} is not pending`);
        waiting.delete(requestID);
        entry.settle(decision, message);
        return null;
      }
      case 'permission.saved.list':
        return [...(options.saved ?? [])];
      case 'agent.list':
        return {
          data: (
            options.agents ?? [
              {
                id: 'build',
                permissions: [{ action: 'read', resource: '*', effect: 'allow' }, ...configRules()],
              },
              {
                id: 'plan',
                permissions: [{ action: 'edit', resource: '*', effect: 'deny' }, ...configRules()],
              },
            ]
          ).map((agent) => ({ ...agent, mode: 'primary' })),
        };
      case 'plugin.list':
        return { data: [...(options.plugins ?? DEFAULT_PLUGINS)] };
      case 'mcp.list': {
        const configured = Object.keys(
          ((config['mcp'] ?? {}) as { servers?: Record<string, unknown> }).servers ?? {},
        );
        return {
          data: (options.servers ?? configured).map((name) => ({ name, status: { status: 'connected' } })),
        };
      }
      case 'config.get':
        return [...(options.configEntries ?? [{ type: 'directory', path: live?.configDirectory ?? '' }])];
      default:
        throw new Error(`${method} is not a call this host answers`);
    }
  };

  const connect: ConnectOpencode = (opened) => {
    record.connects.push(opened);
    record.lifecycle.push('connect');
    if (options.connectFailure !== undefined) {
      return Promise.resolve(
        refuse('runtime-unavailable', `the opencode host process did not open: ${options.connectFailure}`),
      );
    }
    live = opened;
    config = JSON.parse(opened.config) as Record<string, unknown>;
    record.configs.push(config);
    const pid = options.pid === undefined ? 4343 : options.pid;
    for (const one of options.waitingAtOpen ?? []) {
      waiting.set(one.id, {
        session: one.sessionID,
        settle: (decision) => record.settled.push({ requestID: one.id, decision }),
      });
    }
    if (options.askedAtConnect !== undefined) {
      const asked = options.askedAtConnect;
      void record.ask(asked).then((answer) => record.settled.push({ requestID: asked.id, ...answer }));
    }
    const early = options.heldAtConnect;
    if (early !== undefined && opened.onHeldCall !== undefined) {
      void opened
        .onHeldCall({
          tool: early.name,
          sessionID: early.session ?? options.sessionId ?? 'ses_main',
          callId: early.id,
          input: { ...(early.input ?? {}) } as JsonObject,
        })
        .then((answer) => record.held.push({ callId: early.id, allow: answer.allow }));
    }
    return Promise.resolve(
      ok({
        call: async (method: string, input: JsonObject, deadlineMs: number): Promise<Result<JsonValue>> => {
          record.calls.push({ method, input });
          if (closed) return refuse('rpc-request-failed', `${method}: the peer has ended`);
          if (options.hanging?.includes(method) === true) {
            await new Promise((resolve) => setTimeout(resolve, deadlineMs));
            return refuse('rpc-request-timed-out', `${method} met no answer within ${deadlineMs} ms`);
          }
          const failing = options.failing?.[method];
          if (failing !== undefined) return refuse('rpc-request-failed', `${method}: ${failing}`);
          await Promise.resolve();
          try {
            return ok(JSON.parse(JSON.stringify(answer(method, input) ?? null)) as JsonValue);
          } catch (error) {
            return refuse(
              'rpc-request-failed',
              `${method}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },
        pid,
        exited: exitedPromise,
        close: () => {
          if (!closed) {
            closed = true;
            record.lifecycle.push('close');
            exited({ code: 0, signal: null, error: null });
          }
          return Promise.resolve();
        },
      }),
    );
  };

  return { connect, record };
}
