/**
 * One pi session's gate: the hook channel this host's extension asks over, every call it asks about
 * decided by the per-call decision every runtime shares, the extension's hello awaited before the
 * session takes a prompt, and anything found running that this host did not load named on the
 * session's state lane.
 *
 * pi runs a call only once every `tool_call` handler has let it, and this host's extension is the last
 * of them, so its answer is the one that holds. It answers within its own deadline, which sits past the
 * host's decision deadline, so the host's deadline is the one that names an expiry; pi itself waits on
 * a handler for as long as it takes, and has no deadline of its own to order against.
 *
 * An allow carries the operator's rewritten input where it has one: pi runs the very object its handler
 * was handed, so the extension puts the rewrite in place of the old input and the call runs as allowed
 * (`canRewriteInput: true`). A deny carries its reason, which the model is told.
 *
 * What it names, raised once per (name, key):
 * - `gate-foreign-extension`, known when the session opens: a command, a tool or a server whose source is
 *   not this host's extension, pi's own built-ins, its MCP extension or a skill this host handed over.
 *   The session's opening tier drops to `intercepted-with-residual` with it.
 * - `gate-credential-in-shell`, known when the session opens: the endpoint's own variables, which pi puts
 *   in the environment every command the agent runs inherits.
 */
import { resolve } from 'node:path';

import type { RefusalReason } from '../core/refusal.js';
import type { Result } from '../core/result.js';
import type { CallDecision } from '../gate/call-decision.js';
import { createCallDecision } from '../gate/call-decision.js';
import type { Decider } from '../gate/decision.js';
import { HOOK_DEADLINE_MARGIN_MS } from '../gate/hook-exchange.js';
import type { LocalGate } from '../gate/local.js';
import type { GateOutcome } from '../gate/outcome.js';
import { readPiToolCall } from '../gate/pi-request.js';
import { PI_RUNTIME } from '../sessions/runtimes.js';
import type { ControlTierLevel } from '../state/model.js';
import type { SpawnDegrade } from './codex-gate.js';
import { hookDecisionOf } from './codex-gate.js';
import { openHookChannel } from './hook-channel.js';
import type { PiHello, PiHelloEntry } from './pi-extension.js';
import { PI_NAMES } from './pi-names.js';

/** How many distinct degrades one session raises at most; past it, the host's own log still has each. */
const MAX_RAISED_DEGRADES = 4096;

/** The level a session's opening tier drops to when a degrade is known at its open. */
export const PI_DEGRADED_LEVEL: ControlTierLevel = 'intercepted-with-residual';

/** One pi session's gate, as its process uses it. */
export interface PiSessionGate {
  /** Marks this as a pi session's gate, for the registry's route. */
  readonly runtime: typeof PI_RUNTIME;
  /** The channel's address, for the extension's configuration. */
  readonly address: string;
  /** The channel's token, for the extension's configuration. */
  readonly token: string;
  /** How long the extension waits for one decision before it blocks the call. */
  readonly extensionDeadlineMs: number;
  /** Settles once the channel is listening, or refuses `pi-extension-not-active` with why it could not. */
  ready(): Promise<Result<void>>;
  /** The extension's hello once it has arrived, or null when `deadlineMs` passes first or the gate closes. */
  hello(deadlineMs: number): Promise<PiHello | null>;
  /** Told pi's session id once pi has named it. */
  identify(sessionId: string): void;
  /** A named degrade on the session's state lane, once per (name, key). */
  raise(name: RefusalReason, detail: string, key: string): void;
  /** The degrades known at the open: in the opening tier, at its lowered level, each raised once. */
  stateSpawnDegrades(found: readonly SpawnDegrade[]): void;
  /** Stops listening and ends every pending decision. Idempotent. */
  close(): void;
}

export interface PiSessionGateOptions {
  readonly sessionKey: string;
  /** The session's working directory: where pi runs every call. */
  readonly cwd: string;
  readonly decide: Decider;
  readonly localGate?: LocalGate;
  readonly decisionTimeoutMs: number;
  readonly holdAfterMs: number;
  /** This host's version, answered to the extension's hello. */
  readonly version: string;
  /** Told every gate outcome: the session's machine, its items, the embedder. */
  readonly onOutcome: (outcome: GateOutcome) => void;
  /** A degrade for the session's state lane. */
  readonly onDegrade: (name: RefusalReason, detail: string) => void;
  /** The degrades known at the open, and the level the opening tier drops to with them. */
  readonly onSpawnDegrades: (names: readonly RefusalReason[], level: ControlTierLevel) => void;
  /** A request the channel refused before deciding anything. */
  readonly onChannelRefused?: (detail: string) => void;
  readonly platform?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An entry of a hello, read, or null. */
function helloEntry(value: unknown): PiHelloEntry | null {
  if (!isRecord(value)) return null;
  const { name, kind, source, path, baseDir } = value;
  if (typeof name !== 'string' || typeof source !== 'string' || typeof path !== 'string') return null;
  return {
    name,
    ...(typeof kind === 'string' ? { kind } : {}),
    source,
    path,
    ...(typeof baseDir === 'string' ? { baseDir } : {}),
  };
}

/** A list of a hello, read: null when the extension said it could not list it, or sent no list. */
function helloList(value: unknown): PiHelloEntry[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((one: unknown) => {
    const read = helloEntry(one);
    return read === null ? [] : [read];
  });
}

/** What the extension's hello carried, read; absent members read as nothing known. */
export function readPiHello(event: unknown): PiHello {
  const body = isRecord(event) ? event : {};
  const servers = Array.isArray(body['servers'])
    ? (body['servers'] as unknown[]).flatMap((one) =>
        isRecord(one) && typeof one['name'] === 'string' && typeof one['extensionPath'] === 'string'
          ? [{ name: one['name'], extensionPath: one['extensionPath'] }]
          : [],
      )
    : null;
  return {
    reason: typeof body['reason'] === 'string' ? body['reason'] : 'startup',
    tools: helloList(body['tools']),
    commands: helloList(body['commands']),
    servers,
    truncated: body['truncated'] === true,
  };
}

/** Where this host's own code and handed-over skills are, against which every source is read. */
export interface PiOwnSources {
  /** This host's extension, by absolute path. */
  readonly extensionPath: string;
  /** The skill directories handed over with `--skill`. */
  readonly skillDirectories: readonly string[];
  readonly platform?: string;
}

/** `path` as the platform compares paths: resolved, its separators one kind, without case on Windows. */
function comparable(path: string, platform: string): string {
  const resolved = resolve(path).replace(/\\/g, '/');
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** pi's MCP extension, the one built-in extension the launch names. */
const PI_MCP_EXTENSION = 'builtin:mcp';

/**
 * Every source the open found that is not this host's: a tool, a command or a server from anywhere but
 * this host's extension, pi's built-in tools, its MCP extension or a skill directory this host handed
 * over. Each is one line naming what and where, for the degrade's detail. Prompt templates are text, not
 * code, and are not read here. A list the extension could not give, or that was cut, is named too: what
 * was not seen is not called clean.
 */
export function piForeignSources(
  hello: PiHello,
  commands: readonly PiHelloEntry[] | null,
  own: PiOwnSources,
): string[] {
  const platform = own.platform ?? process.platform;
  const extension = comparable(own.extensionPath, platform);
  const skills = own.skillDirectories.map((directory) => comparable(directory, platform));
  const builtinTools = new Set(PI_NAMES.tools.map((tool) => `builtin:${tool}`));
  const isOwnFile = (path: string): boolean =>
    !path.startsWith('builtin:') && comparable(path, platform) === extension;
  const underSkills = (path: string): boolean => {
    if (path.startsWith('builtin:') || path.startsWith('<')) return false;
    const read = comparable(path, platform);
    return skills.some((directory) => read === directory || read.startsWith(`${directory}/`));
  };

  const found: string[] = [];
  for (const tool of hello.tools ?? []) {
    if (isOwnFile(tool.path) || builtinTools.has(tool.path) || tool.path === PI_MCP_EXTENSION) continue;
    found.push(`the tool ${tool.name} from ${tool.path}`);
  }
  const seen = new Set<string>();
  for (const command of [...(commands ?? []), ...(hello.commands ?? [])]) {
    const key = `${command.kind ?? ''}\u0000${command.name}\u0000${command.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (command.kind === 'prompt') continue;
    if (command.kind === 'skill') {
      if (underSkills(command.baseDir ?? command.path)) continue;
      found.push(`the skill ${command.name} from ${command.baseDir ?? command.path}`);
      continue;
    }
    if (isOwnFile(command.path) || command.path === PI_MCP_EXTENSION) continue;
    found.push(`the command ${command.name} from ${command.path}`);
  }
  for (const server of hello.servers ?? []) {
    if (isOwnFile(server.extensionPath)) continue;
    found.push(`the MCP server ${server.name} registered by ${server.extensionPath}`);
  }
  if (hello.tools === null) found.push('the tools pi offers, which the extension could not list');
  if (hello.commands === null && commands === null)
    found.push('the commands pi offers, which nobody could list');
  if (hello.truncated) found.push('more than the extension could list in one hello');
  return found;
}

/** Build one pi session's gate. The channel starts listening at once. */
export function createPiSessionGate(options: PiSessionGateOptions): PiSessionGate {
  const platform = options.platform ?? process.platform;
  const raised = new Set<string>();
  let sessionId = '';
  let said: PiHello | null = null;
  let closed = false;
  const waiting = new Set<(hello: PiHello | null) => void>();

  const raise = (name: RefusalReason, detail: string, key: string): void => {
    const id = `${name}\u0000${key}`;
    if (raised.has(id) || raised.size >= MAX_RAISED_DEGRADES) return;
    raised.add(id);
    try {
      options.onDegrade(name, detail);
    } catch {
      // A listener that throws must not stop the gate answering the call it was raised beside.
    }
  };

  const decide: CallDecision = createCallDecision({
    decide: options.decide,
    onOutcome: options.onOutcome,
    sessionKey: options.sessionKey,
    runtime: PI_RUNTIME,
    ...(options.localGate === undefined ? {} : { localGate: options.localGate }),
    decisionTimeoutMs: options.decisionTimeoutMs,
    holdAfterMs: options.holdAfterMs,
    // pi runs the object its handler was handed, which the extension rewrites in place.
    canRewriteInput: true,
  });

  const channel = openHookChannel({
    runtime: PI_RUNTIME,
    version: options.version,
    platform,
    unavailableReason: 'pi-extension-not-active',
    ...(options.onChannelRefused === undefined ? {} : { onRefused: options.onChannelRefused }),
    onHello: (event) => {
      if (said !== null) return;
      said = readPiHello(event);
      for (const settle of waiting) settle(said);
      waiting.clear();
    },
    decide: async (event, signal) => {
      const request = readPiToolCall(event, {
        sessionId,
        sessionKey: options.sessionKey,
        cwd: options.cwd,
        runtime: PI_RUNTIME,
      });
      return hookDecisionOf(await decide(request, signal));
    },
  });

  return {
    runtime: PI_RUNTIME,
    address: channel.address,
    token: channel.token,
    extensionDeadlineMs: options.decisionTimeoutMs + HOOK_DEADLINE_MARGIN_MS,
    ready: () => channel.ready(),
    hello(deadlineMs) {
      if (said !== null) return Promise.resolve(said);
      if (closed) return Promise.resolve(null);
      return new Promise<PiHello | null>((settle) => {
        const done = (hello: PiHello | null): void => {
          clearTimeout(timer);
          waiting.delete(done);
          settle(hello);
        };
        const timer = setTimeout(() => done(null), deadlineMs);
        waiting.add(done);
      });
    },
    identify(id) {
      sessionId = id;
    },
    raise,
    stateSpawnDegrades(found) {
      if (found.length === 0) return;
      try {
        options.onSpawnDegrades(
          found.map((one) => one.name),
          PI_DEGRADED_LEVEL,
        );
      } catch {
        // The tier is a statement; failing to make it must not end the open.
      }
      for (const one of found) raise(one.name, one.detail, 'open');
    },
    close() {
      if (closed) return;
      closed = true;
      for (const settle of waiting) settle(null);
      waiting.clear();
      channel.close();
    },
  };
}

/** Whether `value` is a pi session gate, as the registry carries it to the runtime's start. */
export function isPiSessionGate(value: unknown): value is PiSessionGate {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { runtime?: unknown }).runtime === PI_RUNTIME &&
    typeof (value as { hello?: unknown }).hello === 'function'
  );
}
