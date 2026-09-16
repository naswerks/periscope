/**
 * The read-only pin: the discovery door cannot write.
 *
 * `host/claude-transcripts.ts` is admitted as read-only over `~/.claude/projects`; the write posture
 * (`credential-path-denied`) is untouched. This pin makes the read-only half a property of the
 * module's import surface rather than a promise in its header: every filesystem name imported
 * anywhere in the module's closure must come from a short read-only allowlist, and any other name
 * (`writeFile`, `appendFile`, `rm`, `mkdir`, `rename`, `open`, whose flags can write,
 * `createWriteStream`, a namespace import that would carry the whole surface) is a violation by
 * name.
 *
 * The selector has its own control below, because a scanner that matches nothing reports the same
 * empty array as a clean tree.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { allFiles, closureFrom } from './walk.js';

const ENTRY = 'host/claude-transcripts.ts';

/** The repository read shares the posture and the allowlist, plus `realpath` for its physical containment check. */
const REPOSITORY_ENTRY = 'host/repository-read.ts';

/** The entire read-only surface the door is allowed. Adding a name here is a decision, not a fix. */
const ALLOWED_FS_IMPORTS = new Set(['createReadStream', 'readdir', 'stat', 'realpath']);

const FS_SPECIFIER = /^node:fs(\/\w+)?$/;

/** Comments and line comments removed, so prose about writing is not a write. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

interface FsImport {
  readonly path: string;
  readonly name: string;
}

/**
 * Every name a file imports from a `node:fs*` module — named, aliased, namespace or default.
 * A namespace or default import is reported as `*`, because it carries the whole surface.
 */
export function fsImportsIn(path: string, text: string): FsImport[] {
  const code = withoutComments(text);
  const found: FsImport[] = [];

  const named = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  for (const match of code.matchAll(named)) {
    const specifier = match[2] ?? '';
    if (!FS_SPECIFIER.test(specifier)) continue;
    for (const binding of (match[1] ?? '').split(',')) {
      const name =
        binding
          .trim()
          .split(/\s+as\s+/)[0]
          ?.trim() ?? '';
      if (name.length > 0) found.push({ path, name });
    }
  }

  const whole = /import\s+(?:type\s+)?(?:\*\s+as\s+\w+|\w+)\s*(?:,\s*\{[^}]*\})?\s*from\s*['"]([^'"]+)['"]/g;
  for (const match of code.matchAll(whole)) {
    const specifier = match[1] ?? '';
    if (FS_SPECIFIER.test(specifier)) found.push({ path, name: '*' });
  }

  return found;
}

test('regression: the discovery closure imports no write-capable filesystem name', () => {
  const closure = closureFrom(ENTRY);

  // Positive control on the walk itself: an untraversed closure would pass the assertion below
  // over nothing. The door reaches the real resolver and the core path rules by design.
  assert.ok(closure.has(ENTRY), 'the walk lost its own entry point');
  assert.ok(closure.has('host/paths.ts'), 'the closure missed the resolver; the walk is wrong');
  assert.ok(closure.has('core/paths.ts'), 'the closure missed the containment rules; the walk is wrong');

  const byPath = new Map(allFiles().map((file) => [file.path, file.text]));
  const violations: string[] = [];
  let sawAllowed = 0;

  for (const path of closure) {
    const text = byPath.get(path);
    if (text === undefined) continue;
    for (const { name } of fsImportsIn(path, text)) {
      if (ALLOWED_FS_IMPORTS.has(name)) sawAllowed += 1;
      else violations.push(`${path} imports ${name}`);
    }
  }

  assert.deepEqual(violations, [], `the discovery door must stay read-only:\n  ${violations.join('\n  ')}`);
  // A boundary around an empty room is not a boundary: the door genuinely reads, so the allowed
  // names must actually appear. Zero here means the extractor rotted, not that the door is pure.
  assert.ok(sawAllowed >= 3, `expected the read-only surface in use, saw ${sawAllowed} allowed imports`);
});

test('regression: the repository read closure imports no write-capable filesystem name', () => {
  const closure = closureFrom(REPOSITORY_ENTRY);
  assert.ok(closure.has(REPOSITORY_ENTRY), 'the walk lost its own entry point');
  assert.ok(closure.has('core/paths.ts'), 'the closure missed the containment rules; the walk is wrong');

  const byPath = new Map(allFiles().map((file) => [file.path, file.text]));
  const violations: string[] = [];
  const seen = new Set<string>();
  for (const path of closure) {
    const text = byPath.get(path);
    if (text === undefined) continue;
    for (const { name } of fsImportsIn(path, text)) {
      if (ALLOWED_FS_IMPORTS.has(name)) seen.add(name);
      else violations.push(`${path} imports ${name}`);
    }
  }

  assert.deepEqual(violations, [], `the repository read must stay read-only:\n  ${violations.join('\n  ')}`);
  // The reader genuinely reads and genuinely resolves links, so all four allowed names must appear.
  assert.deepEqual([...seen].sort(), ['createReadStream', 'readdir', 'realpath', 'stat']);
});

test('control: the extractor fires on every forbidden shape it exists to catch', () => {
  // The discriminator: one variable changes (the import), and the two sides must disagree. If the
  // fixture rows below stopped firing, the green above would be the scanner failing, not the
  // module holding.
  for (const bad of [
    "import { appendFile } from 'node:fs/promises';",
    "import { writeFile, rm } from 'node:fs/promises';",
    "import { mkdir as makeDir } from 'node:fs/promises';",
    "import { rename } from 'node:fs';",
    "import { open } from 'node:fs/promises';",
    "import { createWriteStream } from 'node:fs';",
  ]) {
    const names = fsImportsIn('fixture.ts', bad).map((entry) => entry.name);
    assert.ok(names.length > 0, `the extractor missed: ${bad}`);
    assert.ok(
      names.every((name) => !ALLOWED_FS_IMPORTS.has(name)),
      `${bad} extracted as allowed: ${names.join(', ')}`,
    );
  }

  const namespace = fsImportsIn('fixture.ts', "import * as fs from 'node:fs';");
  assert.deepEqual(
    namespace,
    [{ path: 'fixture.ts', name: '*' }],
    'a namespace import must read as the whole surface',
  );

  const defaulted = fsImportsIn('fixture.ts', "import fs from 'node:fs';");
  assert.deepEqual(
    defaulted,
    [{ path: 'fixture.ts', name: '*' }],
    'a default import must read as the whole surface',
  );
});

test('control: the extractor does not fire on prose, other modules, or the allowed surface', () => {
  assert.deepEqual(
    fsImportsIn('fixture.ts', "// once appendFile arrives from 'node:fs/promises' it is over"),
    [],
  );
  assert.deepEqual(fsImportsIn('fixture.ts', "import { join } from 'node:path';"), []);
  assert.deepEqual(
    fsImportsIn('fixture.ts', "import { createReadStream } from 'node:fs';").map((entry) => entry.name),
    ['createReadStream'],
  );
});
