/**
 * The files a patch names, read out of its text.
 *
 * Codex's `apply_patch` tool carries no path field: the whole patch arrives as one string, and the files
 * it touches are named on its header lines. A patch opens with a begin marker and closes with an end
 * marker; between them each file section starts with a header that adds, updates or deletes one file,
 * and an update may carry a second header that moves the file to a new path. Only those header lines
 * are read here. The hunk bodies, which are content, are never read as paths.
 *
 * The same text can reach the host inside a shell command (a patch handed to `apply_patch` on standard
 * input), so the markers are looked for anywhere in the text rather than only at its start.
 */

/** The header that opens a patch. */
const BEGIN_MARKER = '*** Begin Patch';

/** The headers that name a file, each followed by the path. */
const FILE_HEADERS = ['*** Add File: ', '*** Update File: ', '*** Delete File: ', '*** Move to: '] as const;

/**
 * Every path the patch's headers name, in order, duplicates kept; null when the text holds no patch
 * header at all. A path is returned as written: relative paths are relative to the call's working
 * directory, which only the caller knows.
 */
export function patchPaths(text: string): string[] | null {
  const begin = text.indexOf(BEGIN_MARKER);
  if (begin === -1) return null;
  const paths: string[] = [];
  for (const raw of text.slice(begin + BEGIN_MARKER.length).split('\n')) {
    const line = raw.replace(/\r$/, '').trimStart();
    for (const header of FILE_HEADERS) {
      if (!line.startsWith(header)) continue;
      const path = line.slice(header.length).trim();
      if (path !== '') paths.push(path);
    }
  }
  return paths.length === 0 ? null : paths;
}
