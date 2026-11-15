/**
 * How a session wrote, read off the frames a controller received: each tool call the agent made on the
 * session's own thread (its `tool_call` items, joined to their `tool_result`), the refusals its
 * transitions name, and the checks a probe holds them to. A file that landed says only that something
 * wrote it; the calls say which tool did.
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

import type { JsonObject } from '../control/frames.js';
import { readStateTransition } from '../control/frames.js';

/** One tool call the session's items reported, with how its result ended (null before one arrived). */
export interface ToolCallSeen {
  readonly toolUseId: string;
  readonly toolName: string;
  readonly toolKind: string;
  readonly input: Readonly<Record<string, unknown>> | null;
  readonly status: string | null;
}

/** One file a probe asked the agent to write, and the words it asked for. */
export interface ExpectedWrite {
  readonly path: string;
  readonly text: string;
}

/** The session-lane `session_update` bodies a peer received for `sessionId`, in order. */
function updatesOn(raw: readonly string[], sessionId: string): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  for (const text of raw) {
    const frame = JSON.parse(text) as {
      frame?: string;
      sessionId?: string;
      payload?: { kind?: string; body?: unknown };
    };
    if (
      frame.frame !== 'session' ||
      frame.sessionId !== sessionId ||
      frame.payload?.kind !== 'session_update'
    )
      continue;
    const body = frame.payload.body;
    if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
      bodies.push(body as Record<string, unknown>);
    }
  }
  return bodies;
}

/** Every tool call the session's items reported, each with its result's status where one arrived. */
export function toolCallsOn(raw: readonly string[], sessionId: string): ToolCallSeen[] {
  const calls = new Map<string, ToolCallSeen>();
  for (const body of updatesOn(raw, sessionId)) {
    if (body['update'] !== 'agent_item') continue;
    const item = body['item'] as Record<string, unknown> | undefined;
    if (item === undefined) continue;
    const toolUseId = typeof item['toolUseId'] === 'string' ? item['toolUseId'] : null;
    if (toolUseId === null) continue;
    if (item['kind'] === 'tool_call') {
      calls.set(toolUseId, {
        toolUseId,
        toolName: String(item['toolName']),
        toolKind: String(item['toolKind']),
        input:
          typeof item['input'] === 'object' && item['input'] !== null
            ? (item['input'] as Record<string, unknown>)
            : null,
        status: calls.get(toolUseId)?.status ?? null,
      });
    } else if (item['kind'] === 'tool_result') {
      const seen = calls.get(toolUseId);
      if (seen !== undefined) calls.set(toolUseId, { ...seen, status: String(item['status']) });
    }
  }
  return [...calls.values()];
}

/** The `kind/event` of every transition the session sent, in order. */
export function causesOn(raw: readonly string[], sessionId: string): string[] {
  return updatesOn(raw, sessionId).flatMap((body) => {
    const transition = readStateTransition(body as JsonObject);
    return transition === null ? [] : [`${transition.cause.kind}/${transition.cause.event}`];
  });
}

/** A path as a comparison reads it: forward slashes, and on Windows without regard to case. */
function comparable(path: string): string {
  const forward = path.replace(/\\/g, '/');
  return process.platform === 'win32' ? forward.toLowerCase() : forward;
}

/**
 * Holds a session to having written exactly `expected` with its file tools: one completed call of kind
 * `file_write` per path and no other write call, no call of kind `shell`, no write refused as outside
 * the session's roots, and each file on disk with its words. Throws, naming what it saw, on the first
 * that fails.
 */
export function assertWroteWithFileTools(
  raw: readonly string[],
  sessionId: string,
  expected: readonly ExpectedWrite[],
): void {
  const calls = toolCallsOn(raw, sessionId);
  const seen = calls
    .map((call) => `${call.toolName}(${call.toolKind}, ${call.status ?? 'no result'})`)
    .join(', ');

  const shells = calls.filter((call) => call.toolKind === 'shell');
  assert.deepEqual(
    shells.map((call) => call.toolName),
    [],
    `a shell call ran, so a file could have been written by a command: ${seen}`,
  );

  const writes = calls.filter((call) => call.toolKind === 'file_write');
  assert.equal(writes.length, expected.length, `the file-tool writes are not one per file: ${seen}`);
  for (const file of expected) {
    const named = writes.filter((call) => {
      const path = call.input?.['file_path'];
      return typeof path === 'string' && comparable(path) === comparable(file.path);
    });
    assert.equal(named.length, 1, `no single file-tool write named ${file.path}: ${seen}`);
    assert.equal(named[0]?.status, 'completed', `the write to ${file.path} did not complete: ${seen}`);
  }

  const causes = causesOn(raw, sessionId);
  assert.equal(
    causes.includes('refusal/path-escapes-root'),
    false,
    `the gate refused a write it should allow: ${causes.join(', ')}`,
  );

  for (const file of expected) {
    let written: string;
    try {
      written = readFileSync(file.path, 'utf8');
    } catch {
      throw new assert.AssertionError({ message: `${file.path} is not on disk` });
    }
    assert.equal(written.trim(), file.text, `${file.path} does not hold the words asked for`);
  }
}
