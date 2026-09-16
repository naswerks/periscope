/**
 * What actually happens to a tool call under each decision, measured side by side.
 *
 * Run it:  node examples/parallel-run-proof/permission-mode-probe.ts
 *
 * It exists because two different causes produce the same visible outcome (the file is not there)
 * and telling them apart is the difference between "the gate works" and "nothing runs anyway":
 *
 *   DENIED   the controller said no. The tool must not run, and the MODEL must be told why, in the
 *            controller's own words.
 *   ALLOWED  the controller said yes. The tool must run.
 *
 * A probe that only checked whether the file appeared would score both as a pass for the deny case
 * and would never notice that the allow case fails for a reason that has nothing to do with the
 * gate. So both are run and both tool results are printed verbatim; the reader compares.
 *
 * It composes the parts by hand rather than calling `composeSession`, so nothing here can be an
 * artifact of the composer. This is the wiring the package documents, typed out.
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Decision } from '@naswerks/periscope';
import {
  SessionObserver,
  SessionRegistry,
  SessionStateMachine,
  mergeHooks,
  observationHooks,
  permissionHooks,
  readTurnSpend,
  systemClock,
  systemTicker,
} from '@naswerks/periscope';

interface Case {
  readonly label: string;
  readonly decision: Decision;
  /** Whether the gate's decision is made EFFECTIVE. The third case is the whole point. */
  readonly grantOnAllow: boolean;
}

const CASES: Case[] = [
  {
    label: 'DENIED         ',
    decision: { behavior: 'deny', message: 'the probe controller refuses this write' },
    grantOnAllow: false,
  },
  // The residual, kept as a permanent case. An embedder who composes by hand and does not grant
  // gets a gate that cannot say yes, and nothing tells them: the tool simply does not run.
  { label: 'ALLOWED-SILENT ', decision: { behavior: 'allow' }, grantOnAllow: false },
  { label: 'ALLOWED-GRANTED', decision: { behavior: 'allow' }, grantOnAllow: true },
];

let spentUsd = 0;

for (const one of CASES) {
  const cwd = mkdtempSync(join(tmpdir(), 'periscope-permission-probe-'));

  const machine = new SessionStateMachine({
    where: { cwd, worktree: null, branch: null, unknownReason: 'a probe workspace is not a repository' },
    clock: systemClock,
    ticker: systemTicker,
  });
  const observer = new SessionObserver(machine);
  const causes: string[] = [];
  machine.onTransition((transition) => causes.push(`${transition.cause.kind}/${transition.cause.event}`));

  const registry = new SessionRegistry({
    baseEnv: process.env,
    homeDir: process.env['USERPROFILE'] ?? process.env['HOME'] ?? '',
    startTimeoutMs: 120_000,
  });

  const opened = await registry.open({
    cwd,
    prompt:
      `Use the Write tool once to write the single word pomegranate to ${join(cwd, 'probe.txt').replace(/\\/g, '/')}. ` +
      'If it is refused, do not retry and do not use any other tool — just say REFUSED. Then stop.',
    hooks: mergeHooks(
      observationHooks({ observer }),
      permissionHooks({
        sessionKey: `probe-${one.label}`,
        decide: () => Promise.resolve(one.decision),
        onOutcome: () => undefined,
        grantOnAllow: one.grantOnAllow,
      }),
    ),
  });

  if (!opened.ok) {
    console.log(`${one.label} THE SESSION DID NOT START: ${opened.refusal.reason} ${opened.refusal.detail}`);
    continue;
  }

  const session = opened.value;
  let toolResult = '(no tool result was seen)';

  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 150_000);
    session.onMessage((message) => {
      const seen = message as unknown as { type: string; message?: { content?: unknown } };
      // A `user` message on the output stream IS the tool result. It is the only place the CLI says
      // why a tool did not run, and the only place the model's own explanation can be read.
      if (seen.type === 'user') toolResult = JSON.stringify(seen.message?.content);
      if (seen.type === 'result') {
        spentUsd += readTurnSpend(message)?.totalCostUsd ?? 0;
        clearTimeout(timer);
        resolve();
      }
    });
  });

  console.log(
    `${one.label} permissionMode reported by the agent: ${session.facts?.permissionMode ?? '(unknown)'}`,
  );
  console.log(`${one.label} probe.txt on disk: ${existsSync(join(cwd, 'probe.txt'))}`);
  console.log(
    `${one.label} the trace says: ${[...new Set(causes)].filter((c) => !c.startsWith('sdk-message')).join(', ')}`,
  );
  console.log(`${one.label} TOOL RESULT: ${toolResult.slice(0, 600)}`);
  console.log('');

  session.stop('the probe finished');
}

console.log(`MEASURED SPEND: $${spentUsd.toFixed(4)} — read with readTurnSpend, never computed`);
process.exit(0);
