/**
 * The source walker the boundary pins share. A helper, not a suite.
 *
 * `src/pins/` is exempt from the boundary rules it enforces — reading the source tree needs the
 * very imports the rules forbid. The exemption is a whole directory rather than a list of blessed
 * filenames because it is simpler to audit, and it is closed by reachability.test.ts, which proves
 * nothing in here is reachable from either published barrel.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** From dist/pins/ up to the package root. */
const PACKAGE_DIR = fileURLToPath(new URL('../../', import.meta.url));

/** From dist/pins/ up to the package root, then into the SOURCE tree. */
const SRC_DIR = `${PACKAGE_DIR}src/`;

export interface SourceFile {
  /** Slash-separated, relative to src/ — e.g. `control/codec.ts`. */
  readonly path: string;
  readonly text: string;
}

/** Directories under src/ that never ship: the pins, and the helpers only tests import. */
export const EXEMPT_DIRECTORIES: readonly string[] = ['pins/', 'test-support/'];

/** Every shipping `.ts` file under src/ — the set the boundary rules govern. */
export function sourceFiles(): SourceFile[] {
  const found: SourceFile[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (EXEMPT_DIRECTORIES.includes(`${prefix}${entry.name}/`)) continue;
        walk(child, `${prefix}${entry.name}/`);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        // The `.test.ts` exclusion is deliberate. The rules built on this set govern the package's
        // own imports and shipped vocabulary; `allFiles()` below exists for the rules that must see
        // everything, tests included.
        found.push({ path: `${prefix}${entry.name}`, text: readFileSync(child, 'utf8') });
      }
    }
  };
  walk(SRC_DIR, '');
  return found;
}

/** Every `.ts` file under src/, pins included — for rules that must see the exempt directory. */
export function allFiles(): SourceFile[] {
  const found: SourceFile[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(child, `${prefix}${entry.name}/`);
      else if (entry.name.endsWith('.ts')) {
        found.push({ path: `${prefix}${entry.name}`, text: readFileSync(child, 'utf8') });
      }
    }
  };
  walk(SRC_DIR, '');
  return found;
}

/** Directories never scanned by `packageFiles`: installed and emitted output are not this package. */
const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.git']);

/**
 * Files at the given package-relative paths (files or directories, walked recursively), for the
 * rules that reach beyond `src/`: documents, examples, scripts. Paths are slash-separated and
 * relative to the package root, e.g. `examples/README.md`. A missing entry is skipped, so a rule
 * can name optional documents.
 */
export function packageFiles(entries: readonly string[]): SourceFile[] {
  const found: SourceFile[] = [];
  const visit = (absolute: string, relative: string): void => {
    let isDirectory: boolean;
    try {
      isDirectory = statSync(absolute).isDirectory();
    } catch {
      return;
    }
    if (!isDirectory) {
      found.push({ path: relative, text: readFileSync(absolute, 'utf8') });
      return;
    }
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIPPED_DIRS.has(entry.name)) continue;
      visit(`${absolute}/${entry.name}`, `${relative}/${entry.name}`);
    }
  };
  for (const entry of entries) visit(`${PACKAGE_DIR}${entry}`, entry);
  return found;
}

/**
 * The CI workflow the pins read, package-relative. It must exist: a pin that reads a workflow must
 * not pass over nothing.
 */
export function workflowPath(): string {
  const candidate = '.github/workflows/ci.yml';
  try {
    if (statSync(`${PACKAGE_DIR}${candidate}`).isFile()) return candidate;
  } catch {
    // Absent; refused below by name.
  }
  throw new Error(`no CI workflow at ${candidate}, relative to the package root`);
}

const SPECIFIER_PATTERNS = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/**
 * Comments removed, so prose cannot be read as code.
 *
 * The `from '...'` pattern above cannot tell an import statement from a sentence: a comment reading
 * `from "the controller said no"` once made the purity pin report
 * `refusal.ts imports the controller said no`.
 *
 * Stripping is the fix rather than anchoring the pattern to a line start: this package writes
 * multi-line imports, so a line-anchored pattern would stop seeing real ones, and a pin that quietly
 * covers less is worse than the false positive it replaced.
 */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/**
 * A module specifier never contains whitespace, so a captured "specifier" that does is prose.
 *
 * The second of two mechanisms, deliberately redundant with the stripper: a sentence inside a
 * string (rather than a comment) survives stripping, and this catches it.
 */
function looksLikeSpecifier(specifier: string): boolean {
  return specifier.length > 0 && !/\s/.test(specifier);
}

/** Every module specifier a file imports, however it spells the import. */
export function importsOf(text: string): string[] {
  const code = withoutComments(text);
  const specifiers = new Set<string>();
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined && looksLikeSpecifier(specifier)) specifiers.add(specifier);
    }
  }
  return [...specifiers];
}

/**
 * Node-only globals, which an import scan structurally cannot see: `Buffer` is not imported, so a
 * pin that reads imports alone would report a subpath as runtime-agnostic while `Buffer.byteLength`
 * sat inside its closure.
 *
 * Each entry carries the shape of a real use, not the bare word: `'process'` appears in this
 * package as a string in a closed vocabulary and as English in comments.
 */
const NODE_GLOBAL_USES: ReadonlyArray<readonly [string, RegExp]> = [
  ['Buffer', /\bBuffer\s*[.([]/],
  ['process', /\bprocess\s*[.[]/],
  ['global', /\bglobal\s*[.[]/],
  ['__dirname', /\b__dirname\b/],
  ['__filename', /\b__filename\b/],
  ['setImmediate', /\bsetImmediate\s*\(/],
  ['require', /\brequire\s*\(/],
];

/**
 * Every Node-only global a file actually USES, as `path:line uses X` strings.
 *
 * Comments are stripped first for the same reason `importsOf` strips them: prose about a process is
 * not a use of `process`.
 */
export function nodeGlobalUsesIn(file: SourceFile): string[] {
  const found: string[] = [];
  withoutComments(file.text)
    .split('\n')
    .forEach((line, index) => {
      for (const [name, pattern] of NODE_GLOBAL_USES) {
        if (pattern.test(line)) found.push(`${file.path}:${index + 1} uses ${name}`);
      }
    });
  return found;
}

/** `control/codec.ts` + `../core/result.js` -> `core/result.ts`. Bare specifiers give null. */
export function resolveSpecifier(fromPath: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const segments = fromPath.split('/').slice(0, -1);
  for (const part of specifier.replace(/\.js$/, '.ts').split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') segments.pop();
    else segments.push(part);
  }
  return segments.join('/');
}

/** Every in-package file reachable from `entry` by following relative imports. */
export function closureFrom(entry: string): Set<string> {
  const byPath = new Map(allFiles().map((file) => [file.path, file.text]));
  const seen = new Set<string>();
  const pending = [entry];

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    const text = byPath.get(current);
    if (text === undefined) continue;
    for (const specifier of importsOf(text)) {
      const resolved = resolveSpecifier(current, specifier);
      if (resolved !== null) pending.push(resolved);
    }
  }
  return seen;
}
