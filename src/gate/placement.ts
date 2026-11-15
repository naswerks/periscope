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
 * Windows also names one file several ways, and a form that maps to a drive path by its text is mapped
 * to it, so the checks read the path every other spelling is compared with: a device prefix
 * (`\\?\C:\...`, `\\.\C:\...`, which programs hand out for long paths) is the drive path after it,
 * `\\?\UNC\server\share\...` is that share, and a share that names this machine's own drive
 * (`\\localhost\C$\...`) is that drive's path.
 *
 * Which rules hold is read from the call's directory: one spelled the Windows way (a drive or a share)
 * means Windows rules, and any other means POSIX rules, under which only `~` is placed and every other
 * path is the name it has always been.
 *
 * Three forms cannot be placed, and are refused by name: a drive-relative path on another drive, whose
 * directory no call states; another user's home (`~name/...`), which this host cannot find; and a device
 * or volume form that maps to no drive path (`\\?\Volume{...}\`, `\\.\PhysicalDrive0`).
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
  /** The names this machine answers to as a file server, beside `localhost` and the loopback addresses. */
  readonly localNames?: readonly string[] | undefined;
  /** Whether a plain relative path is placed under the directory, or left as written for the resolver. */
  readonly placesRelative: boolean;
}

const DRIVE_ROOTED = /^[A-Za-z]:[\\/]/;
const DRIVE = /^([A-Za-z]):/;

/** Whether an absolute directory is spelled the Windows way: from a drive, or from a share. */
export function isWindowsDirectory(directory: string): boolean {
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

/** Whether a share's server names this machine: `localhost`, a loopback address, or one of `localNames`. */
function namesThisMachine(server: string, localNames: readonly string[]): boolean {
  const name = server.toLowerCase();
  if (name === 'localhost' || name === '--1.ipv6-literal.net' || /^127(\.\d{1,3}){3}$/.test(name))
    return true;
  return localNames.some((local) => local.trim() !== '' && local.trim().toLowerCase() === name);
}

/**
 * `candidate` with a device prefix, or a share of this machine's own drive, mapped to the drive path it
 * names; any other path is returned as written. A device or volume form that names no drive path is
 * refused. Windows reads either separator, so a path that starts with two of either is read here.
 */
function mapped(candidate: string, localNames: readonly string[]): string | Refusal {
  if (!/^[\\/]{2}/.test(candidate)) return candidate;
  let unified = candidate.replace(/\//g, '\\');
  const device = /^\\\\[?.]\\(.*)$/s.exec(unified);
  if (device !== null) {
    const rest = device[1] ?? '';
    if (/^[A-Za-z]:\\/.test(rest)) return rest;
    const share = /^UNC\\(.*)$/is.exec(rest);
    if (share === null) {
      return refusal(
        'path-unplaceable',
        `${candidate} names a device or a volume, which maps to no drive path this host can check`,
      );
    }
    unified = `\\\\${share[1] ?? ''}`;
  }
  const local = /^\\\\([^\\]+)\\([A-Za-z])\$(\\.*)?$/s.exec(unified);
  if (local !== null && namesThisMachine(local[1] ?? '', localNames)) {
    return `${local[2] ?? ''}:${local[3] ?? '\\'}`;
  }
  return device === null ? candidate : unified;
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
 * The drive path a rooted path names when its first segment is read as a drive letter: `/c/Users/x` and
 * `/cygdrive/c/Users/x` as `c:/Users/x`. A POSIX layer on Windows (Git Bash, Cygwin) reads a path that
 * way, and so does the agent CLI for its own tools, where Windows itself reads `/c/Users/x` as the
 * folder `c` at the root of the current drive. Null for any other path. The file a tool opens is one of
 * the two readings, so the protected set is compared with both.
 */
export function driveLetterReading(candidate: string): string | null {
  const drive = /^[\\/](?:(?:proc[\\/])?cygdrive[\\/])?([A-Za-z])(?=[\\/]|$)/.exec(candidate);
  if (drive === null) return null;
  const rest = candidate.slice(drive[0].length);
  return `${drive[1] ?? ''}:${rest === '' ? '/' : rest}`;
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
  const windows = where.directory !== null && isWindowsDirectory(where.directory);
  // With no directory to read the rules from, a path that opens with two backslashes is Windows' own.
  const windowsForm = windows || (where.directory === null && homed.startsWith('\\\\'));
  const form = windowsForm ? mapped(homed, where.localNames ?? []) : homed;
  if (typeof form !== 'string') return form;
  if (windows && where.directory !== null) {
    return placedOnWindows(form, where.directory, where.placesRelative);
  }
  if (isAbsolutePath(form) || !where.placesRelative) return form;
  if (where.directory === null) {
    return refusal(
      'path-not-absolute',
      `${candidate} is relative and the call states no absolute working directory to resolve it against`,
    );
  }
  return `${where.directory}/${form}`;
}
