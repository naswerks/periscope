/**
 * The opencode seam's structural types, held to the SDK's own declared types at the pinned version.
 *
 * `src/host/opencode-sdk.ts` names no type of `@opencode/sdk`, so no declaration this package ships names a
 * package a consumer may not have. What keeps its interfaces honest is this file: each entry of `SHAPE` below
 * compiles only while the SDK's declared types agree with the seam, in the direction the seam uses them. What
 * this host hands the SDK must be what the SDK takes; what the SDK hands back must be what this host reads. A
 * release that renames a member, narrows a parameter or drops an export fails here, by entry, before any
 * session runs on it.
 *
 * The entries are compiled as a program of their own, not with the package, for two reasons the SDK's
 * declarations give:
 * - They import one another without extensions (`./opencode`), which this package's NodeNext resolution does
 *   not follow. Compiled with the package, the SDK's namespace reads as `any`, and every assignment to or from
 *   it would hold whatever the seam declared. The program here resolves as a bundler does, which follows them,
 *   and its first entries hold that none of the SDK's types the others read is `any`.
 * - They reference a library of their own (`esnext.disposable`, through `effect`) that changes standard
 *   types for the whole of any program they are part of. Kept out of the package's compilation, they change
 *   nothing of it.
 *
 * The program reads the exact development dependency, which the confinement pin holds to the pinned version,
 * and the seam's source in this checkout. Nothing here loads the SDK at run time.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import ts from 'typescript';

import { OPENCODE_SDK_PACKAGE } from '../host/opencode-sdk.js';

const at = (relative: string): string =>
  fileURLToPath(new URL(`../../${relative}`, import.meta.url)).replaceAll('\\', '/');

const ROOT = at('');
const SHAPE_FILE = at('src/pins/opencode-sdk-shape.check.ts');
const CONTROL_FILE = at('src/pins/opencode-sdk-shape.control.ts');

const PRELUDE = `
import type * as Sdk from '${OPENCODE_SDK_PACKAGE}';
import type {
  OpencodeCreateOptions,
  OpencodeEvent,
  OpencodeHost,
  OpencodeLocation,
  OpencodeModelRef,
  OpencodeRule,
  OpencodeSdk,
  OpencodeSessionInfo,
} from '../host/opencode-sdk.js';

/** True when \`A\` can be used where \`B\` is expected. */
type Assignable<A, B> = [A] extends [B] ? true : false;
/** True when \`T\` is a type the checker resolved, not \`any\`. */
type Real<T> = 0 extends 1 & T ? false : true;

type Host = Sdk.OpenCode.Interface;
type CreateInput = NonNullable<Parameters<Host['session']['create']>[0]>;
`;

/** Each entry compiles only while it is `true`: `true satisfies false` is a type error naming its entry. */
const SHAPE = `${PRELUDE}
export const SHAPE = {
  // The SDK's types this file reads resolved: none is \`any\`.
  hostResolved: true satisfies Real<Host>,
  createOptionsResolved: true satisfies Real<Sdk.OpenCode.CreateOptions>,
  createInputResolved: true satisfies Real<CreateInput>,
  eventResolved: true satisfies Real<Sdk.OpenCodeEvent>,
  // What this host hands the SDK.
  createOptions: true satisfies Assignable<OpencodeCreateOptions, Sdk.OpenCode.CreateOptions>,
  sessionCreate: true satisfies Assignable<Parameters<OpencodeHost['session']['create']>[0], CreateInput>,
  rule: true satisfies Assignable<OpencodeRule, NonNullable<CreateInput['permissions']>[number]>,
  modelRef: true satisfies Assignable<OpencodeModelRef, Parameters<Host['session']['switchModel']>[0]['model']>,
  location: true satisfies Assignable<OpencodeLocation, NonNullable<Parameters<Host['agent']['list']>[0]>>,
  prompt: true satisfies Assignable<
    Parameters<OpencodeHost['session']['prompt']>[0],
    Parameters<Host['session']['prompt']>[0]
  >,
  interrupt: true satisfies Assignable<
    Parameters<OpencodeHost['session']['interrupt']>[0],
    Parameters<Host['session']['interrupt']>[0]
  >,
  switchModel: true satisfies Assignable<
    Parameters<OpencodeHost['session']['switchModel']>[0],
    Parameters<Host['session']['switchModel']>[0]
  >,
  switchAgent: true satisfies Assignable<
    Parameters<OpencodeHost['session']['switchAgent']>[0],
    Parameters<Host['session']['switchAgent']>[0]
  >,
  environment: true satisfies Assignable<
    Parameters<OpencodeHost['session']['environment']>[0],
    Parameters<Host['session']['environment']>[0]
  >,
  reply: true satisfies Assignable<
    Parameters<OpencodeHost['permission']['reply']>[0],
    Parameters<Host['permission']['reply']>[0]
  >,
  formCancel: true satisfies Assignable<
    Parameters<OpencodeHost['session']['form']['cancel']>[0],
    Parameters<Host['session']['form']['cancel']>[0]
  >,
  savedList: true satisfies Assignable<
    NonNullable<Parameters<OpencodeHost['permission']['saved']['list']>[0]>,
    NonNullable<Parameters<Host['permission']['saved']['list']>[0]>
  >,
  // What the SDK hands back.
  sdk: true satisfies Assignable<typeof Sdk.OpenCode, OpencodeSdk>,
  host: true satisfies Assignable<Host, OpencodeHost>,
  sessionInfo: true satisfies Assignable<Awaited<ReturnType<Host['session']['get']>>, OpencodeSessionInfo>,
  event: true satisfies Assignable<Sdk.OpenCodeEvent, OpencodeEvent>,
} as const;
`;

/** Entries that must not compile: a shape that disagrees, and an \`any\` read as resolved. */
const CONTROL = `${PRELUDE}
export const CONTROL = {
  disagrees: true satisfies Assignable<OpencodeRule, NonNullable<CreateInput['location']>>,
  unresolved: true satisfies Real<any>,
} as const;
`;

const SOURCES = new Map([
  [SHAPE_FILE, SHAPE],
  [CONTROL_FILE, CONTROL],
]);

/** The two files compiled together, with the package's own options but the resolution a bundler uses. */
function compiled(): { program: ts.Program; diagnostics: (file: string) => string[] } {
  const config = ts.readConfigFile(at('tsconfig.json'), (path) => ts.sys.readFile(path));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
  const options: ts.CompilerOptions = {
    ...parsed.options,
    noEmit: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.getSourceFile = (name, language, onError, fresh) => {
    const source = SOURCES.get(name.replaceAll('\\', '/'));
    return source === undefined
      ? getSourceFile(name, language, onError, fresh)
      : ts.createSourceFile(name, source, language);
  };
  host.fileExists = (name) => SOURCES.has(name.replaceAll('\\', '/')) || fileExists(name);
  const program = ts.createProgram([...SOURCES.keys()], options, host);
  return {
    program,
    diagnostics(file) {
      const source = program.getSourceFile(file);
      assert.ok(source !== undefined, `${file} was not compiled`);
      return [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)].map(
        (one) => {
          const line =
            one.start === undefined
              ? ''
              : `line ${source.getLineAndCharacterOfPosition(one.start).line + 1}: `;
          return `${line}${ts.flattenDiagnosticMessageText(one.messageText, ' ')}`;
        },
      );
    },
  };
}

const sources = existsSync(at('src/host/opencode-sdk.ts'));
const skip = sources ? false : 'the seam is read from its source, and this tree has none';

test(
  'the seam agrees with the SDK at the pinned version, in the direction each type is used, and every SDK type it reads resolved',
  { skip, timeout: 120_000 },
  () => {
    const { program, diagnostics } = compiled();
    assert.deepEqual(
      program.getOptionsDiagnostics().map((one) => ts.flattenDiagnosticMessageText(one.messageText, ' ')),
      [],
    );
    assert.deepEqual(diagnostics(SHAPE_FILE), []);
    // The control compiles in the same program: a disagreeing entry and an `any` each fail, by line.
    const control = diagnostics(CONTROL_FILE);
    assert.equal(control.length, 2, control.join('\n'));
    assert.ok(
      control.every((one) => /not assignable|does not satisfy/.test(one)),
      control.join('\n'),
    );
  },
);
