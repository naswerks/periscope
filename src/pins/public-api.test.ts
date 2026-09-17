/**
 * THE PUBLIC-API PIN: every exported name, rendered from the emitted declarations and diffed
 * against `contracts/public-api.txt`.
 *
 * `pins/package-shape.test.ts` proves the export map is the boundary; this proves what crosses it.
 * The surface is read from `dist/*.d.ts` with the compiler's own checker, not from the source, so
 * it is the surface a consumer's editor sees: one sorted line per export, naming its barrel, its
 * kind and its full signature or member list. A renamed member, a widened parameter, a dropped
 * re-export or a new name each reddens as a one-line diff.
 *
 * Accepting a change is `npm run contracts:update`, which sets `PERISCOPE_UPDATE_CONTRACTS=1` and
 * makes this file rewrite the snapshot before the checks run.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import ts from 'typescript';

const at = (relative: string): string => fileURLToPath(new URL(`../../${relative}`, import.meta.url));

const SNAPSHOT = at('contracts/public-api.txt');

const UPDATE = process.env['PERISCOPE_UPDATE_CONTRACTS'] === '1';

/** The two published barrels, then the ten directory barrels the main one is assembled from. */
const BARRELS: ReadonlyArray<readonly [string, string]> = [
  ['index', 'dist/index.d.ts'],
  ['protocol', 'dist/protocol.d.ts'],
  ...[
    'core',
    'gate',
    'host',
    'identity',
    'mcp',
    'persistence',
    'sessions',
    'state',
    'telemetry',
    'workspace',
  ].map((dir): readonly [string, string] => [dir, `dist/${dir}/index.d.ts`]),
];

const KINDS = ['class', 'interface', 'type', 'function', 'const', 'enum', 'namespace'] as const;
type Kind = (typeof KINDS)[number];

/** The key half of a line: `<barrel>: <kind> <Name>`. What follows is the signature. */
const LINE_KEY = new RegExp(`^([a-z]+): (${KINDS.join('|')}) ([A-Za-z_$][\\w$]*)`);

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------

const FORMAT = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;

/** One line per export, whatever the checker prints; a signature spanning lines is one line here. */
const oneLine = (text: string): string => text.replace(/\s*\r?\n\s*/g, ' ');

interface Renderer {
  readonly checker: ts.TypeChecker;
  readonly scope: ts.SourceFile;
}

function typeText({ checker, scope }: Renderer, type: ts.Type, flags = FORMAT): string {
  return oneLine(checker.typeToString(type, scope, flags));
}

function signatureText(
  { checker, scope }: Renderer,
  signature: ts.Signature,
  kind?: ts.SignatureKind,
): string {
  return oneLine(checker.signatureToString(signature, scope, FORMAT, kind));
}

function isReadonly(symbol: ts.Symbol): boolean {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  return (
    declaration !== undefined && (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Readonly) !== 0
  );
}

/** Sorted `name: type` members plus call and construct signatures, as `{ ... }`. */
function memberList(renderer: Renderer, type: ts.Type, omit: ReadonlySet<string> = new Set()): string {
  const { checker } = renderer;
  // `#private` is the declaration emitter's marker for a class with ECMAScript private fields. It
  // names nothing a consumer can reach, so it is not surface.
  const members = type
    .getProperties()
    .filter((property) => !omit.has(property.name) && property.name !== '#private')
    .map((property) => {
      const optional = (property.flags & ts.SymbolFlags.Optional) !== 0 ? '?' : '';
      const readonly = isReadonly(property) ? 'readonly ' : '';
      return `${readonly}${property.name}${optional}: ${typeText(renderer, checker.getTypeOfSymbol(property))}`;
    })
    .sort();
  const calls = type.getCallSignatures().map((signature) => signatureText(renderer, signature));
  const constructs = type
    .getConstructSignatures()
    .map((signature) => signatureText(renderer, signature, ts.SignatureKind.Construct));
  const all = [...constructs, ...calls, ...members];
  return all.length === 0 ? ' {}' : ` { ${all.join('; ')} }`;
}

function typeParameters(symbol: ts.Symbol): string {
  const declaration = symbol.declarations?.find(
    (candidate): candidate is ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.ClassDeclaration =>
      ts.isInterfaceDeclaration(candidate) ||
      ts.isTypeAliasDeclaration(candidate) ||
      ts.isClassDeclaration(candidate),
  );
  const parameters = declaration?.typeParameters;
  if (parameters === undefined || parameters.length === 0) return '';
  return `<${parameters.map((parameter) => oneLine(parameter.getText())).join(', ')}>`;
}

/** Every line one exported symbol contributes. A merged declaration contributes one per kind. */
function renderSymbol(renderer: Renderer, barrel: string, name: string, target: ts.Symbol): string[] {
  const { checker } = renderer;
  const lines: string[] = [];
  const line = (kind: Kind, rest: string): void => {
    lines.push(`${barrel}: ${kind} ${name}${rest}`);
  };

  if (target.flags & ts.SymbolFlags.Class) {
    const instance = checker.getDeclaredTypeOfSymbol(target);
    const constructor = checker.getTypeOfSymbol(target);
    const statics = constructor
      .getProperties()
      .filter((property) => property.name !== 'prototype')
      .map((property) => `static ${property.name}: ${typeText(renderer, checker.getTypeOfSymbol(property))}`)
      .sort();
    const constructs = constructor
      .getConstructSignatures()
      .map((signature) => signatureText(renderer, signature, ts.SignatureKind.Construct));
    const members = memberList(renderer, instance).slice(3, -2);
    const all = [...constructs, ...statics, ...(members.length > 0 ? [members] : [])];
    line('class', `${typeParameters(target)} { ${all.join('; ')} }`);
  } else if (target.flags & ts.SymbolFlags.Interface) {
    line(
      'interface',
      `${typeParameters(target)}${memberList(renderer, checker.getDeclaredTypeOfSymbol(target))}`,
    );
  }

  if (target.flags & ts.SymbolFlags.TypeAlias) {
    const declared = checker.getDeclaredTypeOfSymbol(target);
    const isPlainObject = (declared.flags & ts.TypeFlags.Object) !== 0 && !declared.isUnionOrIntersection();
    const body = isPlainObject
      ? memberList(renderer, declared).trimStart()
      : typeText(renderer, declared, FORMAT | ts.TypeFormatFlags.InTypeAlias);
    line('type', `${typeParameters(target)} = ${body}`);
  }

  if (target.flags & ts.SymbolFlags.Enum) {
    line('enum', memberList(renderer, checker.getDeclaredTypeOfSymbol(target)));
  }

  if (target.flags & ts.SymbolFlags.Function) {
    const signatures = checker
      .getTypeOfSymbol(target)
      .getCallSignatures()
      .map((signature) => signatureText(renderer, signature));
    line('function', signatures.join('; '));
  } else if (target.flags & ts.SymbolFlags.Variable) {
    line('const', `: ${typeText(renderer, checker.getTypeOfSymbol(target))}`);
  }

  if (target.flags & ts.SymbolFlags.Module && lines.length === 0) {
    line('namespace', '');
  }

  return lines;
}

/** The whole surface: one sorted line per export per barrel. */
export function renderSurface(): string[] {
  const files = BARRELS.map(([, file]) => at(file));
  const program = ts.createProgram(files, {
    skipLibCheck: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  });
  const checker = program.getTypeChecker();

  const lines: string[] = [];
  for (const [barrel, file] of BARRELS) {
    const scope = program.getSourceFile(at(file));
    if (scope === undefined) throw new Error(`${file} is not in the program; run \`npx tsc\` first`);
    const moduleSymbol = checker.getSymbolAtLocation(scope);
    if (moduleSymbol === undefined) throw new Error(`${file} has no module symbol`);
    const renderer: Renderer = { checker, scope };
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      lines.push(...renderSymbol(renderer, barrel, exported.name, target));
    }
  }
  return [...new Set(lines)].sort();
}

// ---------------------------------------------------------------------------
// The diff, keyed on `<barrel>: <kind> <Name>` so a changed signature reads as changed rather
// than as one removal and one addition.
// ---------------------------------------------------------------------------

export interface SurfaceDiff {
  readonly added: string[];
  readonly removed: string[];
  readonly changed: string[];
}

function keyOf(line: string): string {
  return LINE_KEY.exec(line)?.[0] ?? line;
}

export function diffSurface(before: readonly string[], after: readonly string[]): SurfaceDiff {
  const byKey = (lines: readonly string[]): Map<string, string> =>
    new Map(lines.map((line) => [keyOf(line), line]));
  const was = byKey(before);
  const is = byKey(after);

  const added = [...is].filter(([key]) => !was.has(key)).map(([, line]) => line);
  const removed = [...was].filter(([key]) => !is.has(key)).map(([, line]) => line);
  const changed = [...is]
    .filter(([key, line]) => was.has(key) && was.get(key) !== line)
    .map(
      ([key, line]) =>
        `${key}\n      was: ${was.get(key)?.slice(key.length) ?? ''}\n      now: ${line.slice(key.length)}`,
    );
  return { added, removed, changed };
}

export function describeDiff(diff: SurfaceDiff): string {
  const section = (title: string, lines: readonly string[]): string =>
    lines.length === 0 ? '' : `  ${title}:\n    ${lines.join('\n    ')}\n`;
  return section('added', diff.added) + section('removed', diff.removed) + section('changed', diff.changed);
}

const isEmpty = (diff: SurfaceDiff): boolean =>
  diff.added.length + diff.removed.length + diff.changed.length === 0;

// ---------------------------------------------------------------------------
// The snapshot on disk.
// ---------------------------------------------------------------------------

function readSnapshot(): string[] {
  if (!existsSync(SNAPSHOT)) return [];
  return readFileSync(SNAPSHOT, 'utf8')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => line.length > 0);
}

function writeSnapshot(lines: readonly string[]): void {
  const before = readSnapshot();
  const diff = diffSurface(before, lines);
  writeFileSync(SNAPSHOT, `${lines.join('\n')}\n`);
  process.stdout.write(
    `public-api: wrote contracts/public-api.txt (${lines.length} lines; ` +
      `+${diff.added.length} -${diff.removed.length} ~${diff.changed.length})\n${describeDiff(diff)}`,
  );
}

const SURFACE = renderSurface();

if (UPDATE) writeSnapshot(SURFACE);

// ---------------------------------------------------------------------------

test('the emitted public API matches contracts/public-api.txt', () => {
  assert.ok(
    existsSync(SNAPSHOT),
    'contracts/public-api.txt is missing; run `npm run contracts:update` to create it',
  );
  const diff = diffSurface(readSnapshot(), SURFACE);
  assert.ok(
    isEmpty(diff),
    `the public API differs from contracts/public-api.txt:\n${describeDiff(diff)}run \`npm run contracts:update\` to accept`,
  );
});

test('the snapshot is sorted, LF and one line per export', () => {
  const raw = readFileSync(SNAPSHOT, 'utf8');
  assert.ok(!raw.includes('\r'), 'the snapshot carries a CR; it must be LF');
  assert.ok(raw.endsWith('\n') && !raw.endsWith('\n\n'), 'the snapshot must end with exactly one newline');
  const lines = readSnapshot();
  assert.deepEqual(lines, [...lines].sort(), 'the snapshot is not sorted');
  const unkeyed = lines.filter((line) => !LINE_KEY.test(line));
  assert.deepEqual(unkeyed, [], `lines with no <barrel>: <kind> <Name> key:\n  ${unkeyed.join('\n  ')}`);
});

// Positive controls: the renderer saw the real surface, or the diff above is a diff of nothing.
test('control: the rendered surface carries the names the package is known by', () => {
  const names = new Set(SURFACE.map((line) => LINE_KEY.exec(line)?.[3]));
  for (const expected of [
    'PeriscopeHost',
    'encode',
    'decode',
    'PROTOCOL_VERSION',
    'Decider',
    'SessionFrame',
    'REFUSAL_REASONS',
  ]) {
    assert.ok(names.has(expected), `${expected} is missing from the rendered surface`);
  }
  assert.match(
    SURFACE.find((line) => line.startsWith('protocol: const PROTOCOL_VERSION')) ?? '',
    /: \d+$/,
    'the version renders as its literal',
  );
  assert.match(
    SURFACE.find((line) => line.startsWith('protocol: function encode')) ?? '',
    /\(frame: Frame\): Result<string>/,
  );
  assert.match(SURFACE.find((line) => line.startsWith('index: class PeriscopeHost')) ?? '', /new \(/);
});

test('control: every barrel renders at least three exports, and no line is machine-specific', () => {
  for (const [barrel] of BARRELS) {
    const count = SURFACE.filter((line) => line.startsWith(`${barrel}: `)).length;
    assert.ok(count >= 3, `${barrel} renders ${count} export(s)`);
  }
  const local = SURFACE.filter((line) => /[A-Za-z]:[\\/]|\/home\/|\/Users\//.test(line));
  assert.deepEqual(
    local,
    [],
    `a line names a local path, so the snapshot would differ per machine:\n  ${local.join('\n  ')}`,
  );
});

test('control: the package-private loopback seam is absent from both published barrels', () => {
  // The same control `pins/package-shape.test.ts` uses, seen from the declarations rather than
  // the runtime namespace: an absence in both is a claim the export map keeps.
  assert.ok(
    SURFACE.some((line) => line.startsWith('index: function openLoopbackListener(')),
    'the public listener is missing; the surface was not read',
  );
  const leaked = SURFACE.filter(
    (line) => /openLoopbackListenerWith/.test(line) && /^(index|protocol): /.test(line),
  );
  assert.deepEqual(leaked, [], 'the injected-constructor seam is on a published barrel');
});

test('control: the diff reports a one-line synthetic change as changed, and an addition and a removal by name', () => {
  const before = ['core: const A: 1', 'core: function f(x: number): void', 'gate: interface G { a: string }'];
  const after = ['core: const A: 2', 'gate: interface G { a: string }', 'gate: type T = string'];

  const diff = diffSurface(before, after);
  assert.deepEqual(diff.added, ['gate: type T = string']);
  assert.deepEqual(diff.removed, ['core: function f(x: number): void']);
  assert.equal(diff.changed.length, 1);
  assert.match(diff.changed[0] ?? '', /^core: const A\n\s+was: : 1\n\s+now: : 2$/);

  assert.ok(isEmpty(diffSurface(after, after)), 'an identical surface must diff empty');
  assert.match(describeDiff(diff), /added:\n\s+gate: type T = string\n\s+removed:/);

  // The real snapshot minus one line reports exactly that line removed.
  const snapshot = readSnapshot();
  const dropped = snapshot.slice(1);
  assert.deepEqual(diffSurface(snapshot, dropped).removed, [snapshot[0]]);
});
