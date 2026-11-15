/**
 * Where a path a tool names lands: the file the operating system opens for a tool running in the call's
 * directory.
 *
 * A tool does not hand its path to this host to open. It opens the path itself, where it runs, and the
 * operating system places every form its own way: on Windows a path that starts with one separator is
 * rooted at the current drive, and `C:name` is relative to the current directory when that directory is
 * on drive C. Joining such a path under the call's directory as text would check one file while the tool
 * opens another, so each is placed here first and the jail and the protected set then read the result.
 *
 * Which rules hold is read from the call's directory: one spelled the Windows way (a drive or a share)
 * means Windows rules, and any other means POSIX rules, under which only `~` is placed and every other
 * path is the name it has always been.
 *
 * Two forms cannot be placed, and are refused by name: a drive-relative path on another drive, whose
 * directory no call states, and another user's home (`~name/...`), which this host cannot find.
 */
import type { Refusal } from '../core/refusal.js';
import { refusal } from '../core/refusal.js';
import { isAbsolutePath } from '../core/paths.js';

/** What a path is placed against. */
export interface Placement {
  /** The directory the call runs in, absolute; null when neither the call nor the session states one. */
  readonly directory: string | null;
  /** The home directory `~` names. Absent or null: a `~` path is read as written. */
  readonly home?: string | null | undefined;
  /** Whether a plain relative path is placed under the directory, or left as written for the resolver. */
  readonly placesRelative: boolean;
}

const DRIVE_ROOTED = /^[A-Za-z]:[\\/]/;
const DRIVE = /^([A-Za-z]):/;

/** Whether an absolute directory is spelled the Windows way: from a drive, or from a share. */
function isWindowsDirectory(directory: string): boolean {
  return DRIVE.test(directory) || directory.startsWith('\\\\');
}

/**
 * `candidate` with its home form spelled out: `~`, `~/x` and `~\x` are the home directory and what
 * follows. With no home known the path is returned as written. Another user's home is refused.
 */
function atHome(candidate: string, home: string | null | undefined): string | Refusal {
  if (candidate === '~' || /^~[\\/]/.test(candidate)) {
    return home === null || home === undefined || home.trim() === ''
      ? candidate
      : `${home}${candidate.slice(1)}`;
  }
  if (/^~[^\\/]+[\\/]/.test(candidate)) {
    return refusal(
      'path-unplaceable',
      `${candidate} starts at another user's home directory, which this host cannot place`,
    );
  }
  return candidate;
}

/** The root a path with one leading separator starts at: the directory's drive, or its share. */
function rootOf(directory: string): string {
  const drive = DRIVE.exec(directory);
  if (drive !== null) return `${drive[1] ?? ''}:`;
  return /^\\\\[^\\/]+[\\/][^\\/]+/.exec(directory)?.[0] ?? directory;
}

/** `candidate` placed by Windows' rules for a tool whose current directory is `directory`. */
function placedOnWindows(candidate: string, directory: string, placesRelative: boolean): string | Refusal {
  if (DRIVE_ROOTED.test(candidate) || /^[\\/]{2}/.test(candidate)) return candidate;
  const drive = DRIVE.exec(candidate);
  if (drive !== null) {
    const letter = drive[1] ?? '';
    const own = DRIVE.exec(directory)?.[1];
    if (own !== undefined && own.toLowerCase() === letter.toLowerCase()) {
      const rest = candidate.slice(2);
      return rest === '' ? directory : `${directory}\\${rest}`;
    }
    return refusal(
      'path-unplaceable',
      `${candidate} is relative to the current directory of drive ${letter.toUpperCase()}:, which no call states`,
    );
  }
  if (/^[\\/]/.test(candidate)) return `${rootOf(directory)}${candidate}`;
  return placesRelative ? `${directory}/${candidate}` : candidate;
}

/**
 * The path `candidate` names for a tool running in `where.directory`, or the refusal for a form that
 * cannot be placed. A plain relative path with no directory to stand on is refused when it was to be
 * placed, because resolving it against this process's own directory would check a file the call never
 * named.
 */
export function placePath(candidate: string, where: Placement): string | Refusal {
  const homed = atHome(candidate, where.home);
  if (typeof homed !== 'string') return homed;
  if (where.directory !== null && isWindowsDirectory(where.directory)) {
    return placedOnWindows(homed, where.directory, where.placesRelative);
  }
  if (isAbsolutePath(homed) || !where.placesRelative) return homed;
  if (where.directory === null) {
    return refusal(
      'path-not-absolute',
      `${candidate} is relative and the call states no absolute working directory to resolve it against`,
    );
  }
  return `${where.directory}/${homed}`;
}
