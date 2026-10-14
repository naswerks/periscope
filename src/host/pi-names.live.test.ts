/**
 * The names snapshot against the pi the operator installed: the declarations its package ships, and the
 * two packages of pi's own it depends on, must declare exactly the events, RPC commands, RPC records,
 * extension UI methods, message deltas and built-in tools `contracts/pi-names.json` holds, at the version
 * the snapshot names, and the CLI must say that version, run from a scratch directory under the OS temp
 * directory so it reads no workspace of anyone's.
 *
 * The coverage pin holds `PI_COVERAGE` to the snapshot from the release's own source with no install;
 * this holds the snapshot to the install, so a pi whose declarations are not the pinned release's is
 * caught as such and never read through a table written for another.
 *
 * It skips loudly: it runs only with `PERISCOPE_LIVE=1` and `PERISCOPE_PI_BIN` naming the installed
 * package's `dist/bundle/cli.js`. Without both, the property is NOT exercised, and the skip says so.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { piCommand, piVersionOf } from './pi-binary.js';
import { PI_NAMES } from './pi-names.js';

const LIVE = process.env['PERISCOPE_LIVE'] === '1';
const BINARY = process.env['PERISCOPE_PI_BIN'] ?? '';
const skip = !LIVE
  ? 'PERISCOPE_LIVE is not set — this property is NOT exercised'
  : BINARY === ''
    ? 'PERISCOPE_PI_BIN is not set — this property is NOT exercised'
    : false;

/** A dependency of the package at `root`: nested under it, or beside it where npm hoisted it. */
function dependency(root: string, name: string): string {
  const scope = name.slice(0, name.indexOf('/'));
  const bare = name.slice(name.indexOf('/') + 1);
  for (const candidate of [join(root, 'node_modules', scope, bare), join(dirname(root), bare)]) {
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return assert.fail(`${name} is installed neither under ${root} nor beside it`);
}

/** The declaration from `opener` to the `;` outside every brace that ends it, comments taken out. */
function declaration(path: string, opener: string): string {
  assert.ok(existsSync(path), `${path} is not in the install`);
  const source = readFileSync(path, 'utf8');
  const start = source.indexOf(opener);
  assert.ok(start >= 0, `${path} has no ${opener}`);
  const text = source
    .slice(start)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '{') depth += 1;
    else if (character === '}') depth -= 1;
    else if (character === ';' && depth === 0) return text.slice(0, index);
  }
  return assert.fail(`${path}: ${opener} is not closed`);
}

/** The string literals `member: "…"` names inside `text`, once each, sorted. */
const literals = (text: string, member: string): string[] =>
  [
    ...new Set(
      [...text.matchAll(new RegExp(`\\b${member}: "([A-Za-z_][A-Za-z0-9_]*)"`, 'g'))].map(
        (match) => match[1] ?? '',
      ),
    ),
  ].sort();

const sorted = (list: readonly string[]): string[] => [...list].sort();

test(
  'the installed pi declares exactly the names the snapshot holds, at the version it names',
  { skip },
  () => {
    const root = dirname(dirname(dirname(BINARY)));
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string };
    assert.equal(manifest.version, PI_NAMES.version, 'the install is another version of pi');
    const scratch = mkdtempSync(`${tmpdir()}/periscope-pi-names-`);
    try {
      const command = piCommand(BINARY, ['--version']);
      const said = execFileSync(command.command, [...command.args], {
        cwd: scratch,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 60_000,
        env: { ...process.env, PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1' },
      });
      assert.equal(piVersionOf(said), PI_NAMES.version, 'the CLI says another version');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    const agent = dependency(root, '@earendil-works/pi-agent-core');
    const ai = dependency(root, '@earendil-works/pi-ai');

    assert.deepEqual(
      literals(declaration(join(agent, 'dist', 'types.d.ts'), 'export type AgentEvent ='), 'type'),
      sorted(PI_NAMES.agentEvents),
    );
    assert.deepEqual(
      literals(
        declaration(join(root, 'dist', 'core', 'agent-session.d.ts'), 'export type AgentSessionEvent ='),
        'type',
      ),
      sorted(PI_NAMES.sessionEvents),
    );
    const rpcTypes = join(root, 'dist', 'modes', 'rpc', 'rpc-types.d.ts');
    assert.deepEqual(
      literals(declaration(rpcTypes, 'export type RpcCommand ='), 'type'),
      sorted(PI_NAMES.rpcCommands),
    );
    const ui = declaration(rpcTypes, 'export type RpcExtensionUIRequest =');
    assert.deepEqual(literals(ui, 'method'), sorted(PI_NAMES.uiMethods));
    const errors = /\btype: "extension_error"/.test(
      readFileSync(join(root, 'dist', 'modes', 'rpc', 'rpc-mode.js'), 'utf8'),
    )
      ? ['extension_error']
      : [];
    assert.deepEqual(
      [
        ...new Set([
          ...literals(declaration(rpcTypes, 'export type RpcResponse ='), 'type'),
          ...literals(ui, 'type'),
          ...errors,
        ]),
      ].sort(),
      sorted(PI_NAMES.rpcRecords),
    );
    assert.deepEqual(
      literals(declaration(join(ai, 'dist', 'types.d.ts'), 'export type AssistantMessageEvent ='), 'type'),
      sorted(PI_NAMES.assistantMessageEvents),
    );
    const tools = /export type ToolName =([^;]+);/.exec(
      readFileSync(join(root, 'dist', 'core', 'tools', 'index.d.ts'), 'utf8'),
    );
    assert.ok(tools !== null, 'the install declares no ToolName');
    assert.deepEqual(
      [...new Set([...(tools[1] ?? '').matchAll(/"([a-z_]+)"/g)].map((match) => match[1] ?? ''))].sort(),
      sorted(PI_NAMES.tools),
    );
  },
);
