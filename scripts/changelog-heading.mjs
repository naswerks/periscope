/**
 * Whether a changelog is ready for a release of `version`: it carries a non-empty Unreleased section
 * (`## Unreleased` or `## [Unreleased]`), or a section for that version (`## [x.y.z]`).
 *
 * Kept apart from the publish gate so the check can be exercised on its own text: the gate runs every
 * other check on import.
 */
export function changelogReady(changelog, version) {
  const unreleased = /^## \[?Unreleased\]?[ \t]*$/m.exec(changelog);
  if (unreleased !== null) {
    const after = changelog.slice(unreleased.index + unreleased[0].length);
    const next = after.search(/^## /m);
    const body = next === -1 ? after : after.slice(0, next);
    if (body.trim() !== '') return true;
  }
  return changelog.includes(`## [${version}]`);
}
