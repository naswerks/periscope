/**
 * Readers for the three git outputs an inventory is built from. Pure: text in, records out, no
 * process and no filesystem, so the parsing is testable against fixtures and the provider that
 * runs the commands stays thin.
 *
 * `git worktree list --porcelain` prints one block per worktree, blank-line separated, each line
 * `<attribute> <value>` or a bare attribute: `worktree <path>`, `HEAD <sha>`, `branch <ref>`,
 * `detached`, `locked [reason]`, `prunable [reason]`, `bare`. Attributes this reader does not know
 * are carried past, never fatal, so a newer git cannot break the inventory by adding one.
 */

/** One worktree as git reports it. `branch` is the short name (`refs/heads/` stripped), null when detached. */
export interface PorcelainWorktree {
  readonly path: string;
  readonly head: string | null;
  readonly branch: string | null;
  readonly detached: boolean;
  readonly locked: boolean;
  readonly prunable: boolean;
  readonly bare: boolean;
}

const HEADS_PREFIX = 'refs/heads/';

export function parseWorktreePorcelain(text: string): PorcelainWorktree[] {
  const worktrees: PorcelainWorktree[] = [];
  let current: {
    path: string;
    head: string | null;
    branch: string | null;
    detached: boolean;
    locked: boolean;
    prunable: boolean;
    bare: boolean;
  } | null = null;

  const flush = (): void => {
    if (current !== null) worktrees.push({ ...current });
    current = null;
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line === '') {
      flush();
      continue;
    }
    const space = line.indexOf(' ');
    const attribute = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? '' : line.slice(space + 1);
    if (attribute === 'worktree') {
      flush();
      current = {
        path: value,
        head: null,
        branch: null,
        detached: false,
        locked: false,
        prunable: false,
        bare: false,
      };
      continue;
    }
    if (current === null) continue;
    switch (attribute) {
      case 'HEAD':
        current.head = value === '' ? null : value;
        break;
      case 'branch':
        current.branch = value.startsWith(HEADS_PREFIX) ? value.slice(HEADS_PREFIX.length) : value;
        break;
      case 'detached':
        current.detached = true;
        break;
      case 'locked':
        current.locked = true;
        break;
      case 'prunable':
        current.prunable = true;
        break;
      case 'bare':
        current.bare = true;
        break;
      default:
        break;
    }
  }
  flush();
  return worktrees;
}

/**
 * `git for-each-ref --format='%(refname:short)%09%(committerdate:iso-strict)' refs/heads/`: one
 * branch per line, tab-separated. Returns the tip's committer date per branch, as given.
 */
export function parseBranchTips(text: string): Map<string, string> {
  const tips = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const branch = line.slice(0, tab).trim();
    const at = line.slice(tab + 1).trim();
    if (branch !== '' && at !== '') tips.set(branch, at);
  }
  return tips;
}

/** `git branch --merged <ref> --format='%(refname:short)'`: one branch per line. */
export function parseBranchList(text: string): Set<string> {
  const branches = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^[*+]\s+/, '');
    if (line !== '') branches.add(line);
  }
  return branches;
}
