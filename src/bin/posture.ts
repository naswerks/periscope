/**
 * What this host is, said once: its ids, its credential, its workspace, its link and where each
 * setting came from. `serve` prints the one-line form at start-up and `status` prints the whole,
 * from one description, so the two can never disagree about the host they describe. Pure over its
 * inputs; the reads that fill them live with the verbs.
 */
import { CONFIG_KEYS, WIRE_CONFIGURABLE_KEYS, configFilePath } from '../host/config-file.js';
import type { LinkStateRecord } from '../host/link-state-file.js';
import type { CredentialPosture } from './serve.js';
import { workspaceCapabilitiesOf } from './workspaces.js';

export interface PostureInputs {
  /** The process environment as it was. */
  readonly raw: NodeJS.ProcessEnv;
  /** The environment with the config file filling its absences. */
  readonly merged: NodeJS.ProcessEnv;
  /** The values the config file holds, so a key can say which source it came from. */
  readonly fileValues: Readonly<Record<string, string>>;
  /** What `readCredential` decided, or its refusal. */
  readonly credential: CredentialPosture | string;
  /** The cached token's expiry in epoch milliseconds, when a token cache is readable. */
  readonly tokenExpiresAtMs: number | null;
  readonly nowMs: number;
  readonly link: LinkStateRecord | null;
  /** Whether the process that wrote the link record is still alive. */
  readonly pidAlive: (pid: number) => boolean;
  /** The machine's hostname, the host id's fallback. */
  readonly hostname: string;
}

export type CredentialKind = 'paired' | 'token' | 'absent' | 'unreadable';
export type WorkspaceMode = 'git-worktree' | 'plain' | 'none';
export type Source = 'environment' | 'config-file' | 'default' | 'unset';

export interface Setting {
  readonly key: string;
  readonly value: string | null;
  readonly source: Source;
  /** Set in both places, and the environment won. */
  readonly shadowsFile: boolean;
}

export interface Posture {
  readonly hostId: {
    readonly configured: string;
    readonly paired: string | null;
    readonly effective: string;
  };
  readonly credential: {
    readonly kind: CredentialKind;
    readonly expiresAt: string | null;
    readonly expired: boolean;
    readonly problem: string | null;
  };
  readonly workspace: { readonly mode: WorkspaceMode; readonly branchScheme: string | null };
  readonly sources: readonly Setting[];
  readonly configFile: string | null;
  readonly link: {
    readonly state: string;
    readonly cause: string | null;
    readonly at: string | null;
    readonly detail: string | null;
    readonly negotiatedVersion: number | null;
    readonly pid: number | null;
    readonly alive: boolean;
  };
}

function settingOf(key: string, inputs: PostureInputs): Setting {
  const fromEnv = inputs.raw[key];
  const fromFile = inputs.fileValues[key];
  const inEnv = fromEnv !== undefined && fromEnv !== '';
  const inFile = fromFile !== undefined && fromFile !== '';
  if (inEnv) return { key, value: fromEnv, source: 'environment', shadowsFile: inFile };
  if (inFile) return { key, value: fromFile, source: 'config-file', shadowsFile: false };
  const merged = inputs.merged[key];
  if (merged !== undefined && merged !== '')
    return { key, value: merged, source: 'default', shadowsFile: false };
  return { key, value: null, source: 'unset', shadowsFile: false };
}

export function describePosture(inputs: PostureInputs): Posture {
  const keys = [
    ...new Set<string>([
      ...CONFIG_KEYS,
      ...WIRE_CONFIGURABLE_KEYS,
      'PERISCOPE_HOST_ID',
      'PERISCOPE_CONFIG_DIR',
    ]),
  ];
  const sources = keys.map((key) => settingOf(key, inputs));
  const value = (key: string): string | null => sources.find((one) => one.key === key)?.value ?? null;

  const configured = value('PERISCOPE_HOST_ID') ?? inputs.hostname;
  const paired = typeof inputs.credential === 'string' ? null : inputs.credential.pairedHostId;

  let kind: CredentialKind;
  let problem: string | null = null;
  if (typeof inputs.credential === 'string') {
    kind = 'unreadable';
    problem = inputs.credential;
  } else if (inputs.credential.pairedHostId !== null) kind = 'paired';
  else if (inputs.credential.credential !== null) kind = 'token';
  else kind = 'absent';
  const expiresAt =
    kind === 'token' && inputs.tokenExpiresAtMs !== null
      ? new Date(inputs.tokenExpiresAtMs).toISOString()
      : null;
  const expired =
    kind === 'token' && inputs.tokenExpiresAtMs !== null && inputs.tokenExpiresAtMs <= inputs.nowMs;

  const capabilities = workspaceCapabilitiesOf({
    workspaceRoot: value('PERISCOPE_WORKSPACE_ROOT'),
    repositoryRoot: value('PERISCOPE_REPOSITORY_ROOT'),
    branchScheme: value('PERISCOPE_BRANCH_SCHEME'),
  });
  const mode: WorkspaceMode = capabilities.includes('workspace:git-worktree')
    ? 'git-worktree'
    : capabilities.includes('workspace:plain')
      ? 'plain'
      : 'none';

  const link = inputs.link;
  return {
    hostId: { configured, paired, effective: paired ?? configured },
    credential: { kind, expiresAt, expired, problem },
    workspace: { mode, branchScheme: value('PERISCOPE_BRANCH_SCHEME') },
    sources,
    configFile: configFilePath(inputs.raw),
    link:
      link === null
        ? {
            state: 'unknown',
            cause: null,
            at: null,
            detail: null,
            negotiatedVersion: null,
            pid: null,
            alive: false,
          }
        : {
            state: link.state,
            cause: link.cause,
            at: link.at,
            detail: link.detail,
            negotiatedVersion: link.negotiatedVersion,
            pid: link.pid,
            alive: inputs.pidAlive(link.pid),
          },
  };
}

/** The one line `serve` prints at start-up: the host, the credential, the workspace, the config file. */
export function postureLine(posture: Posture): string {
  const credential =
    posture.credential.kind === 'token' && posture.credential.expiresAt !== null
      ? `token (expires ${posture.credential.expiresAt})`
      : posture.credential.kind;
  return (
    `host ${posture.hostId.effective}` +
    (posture.hostId.paired !== null && posture.hostId.paired !== posture.hostId.configured
      ? ` (paired; configured ${posture.hostId.configured})`
      : '') +
    ` · credential ${credential} · workspace ${posture.workspace.mode}` +
    ` · config file ${posture.configFile ?? '(none)'}`
  );
}

/** The whole posture, one fact per line, for `periscope status`. */
export function renderPosture(posture: Posture): string[] {
  const lines: string[] = [];
  const link = posture.link;
  if (link.state === 'unknown') {
    lines.push('link: unknown — no serve has run with this config directory, or it wrote nothing yet');
  } else {
    const liveness = link.alive
      ? `serve pid ${link.pid} is running`
      : `serve pid ${link.pid} is gone, so this is the last thing it said`;
    lines.push(
      `link: ${link.state} since ${link.at} (${link.cause}${link.detail === null ? '' : `: ${link.detail}`}); ${liveness}`,
    );
    if (link.negotiatedVersion !== null)
      lines.push(`protocol: v${link.negotiatedVersion} negotiated at the last accepted handshake`);
  }
  const credential = posture.credential;
  switch (credential.kind) {
    case 'paired':
      lines.push(`credential: paired as ${posture.hostId.paired} (no expiry; rotation is re-pairing)`);
      break;
    case 'token':
      lines.push(
        `credential: signed-in token${credential.expiresAt === null ? '' : `, ${credential.expired ? 'EXPIRED at' : 'expires'} ${credential.expiresAt}`}`,
      );
      break;
    case 'absent':
      lines.push('credential: absent — this host dials without authentication');
      break;
    default:
      lines.push(`credential: unreadable — ${credential.problem ?? ''}`);
  }
  lines.push(
    `host id: ${posture.hostId.effective}` +
      (posture.hostId.paired !== null
        ? posture.hostId.paired === posture.hostId.configured
          ? ' (the paired credential agrees)'
          : ` (the paired credential's, overriding the configured ${posture.hostId.configured})`
        : ''),
  );
  lines.push(
    `workspace: ${posture.workspace.mode}${posture.workspace.branchScheme === null ? '' : `, branch scheme ${posture.workspace.branchScheme}`}`,
  );
  lines.push(`config file: ${posture.configFile ?? '(none: no home directory and no PERISCOPE_CONFIG_DIR)'}`);
  for (const setting of posture.sources) {
    const where =
      setting.source === 'environment'
        ? setting.shadowsFile
          ? 'environment, shadowing the config file'
          : 'environment'
        : setting.source;
    lines.push(`  ${setting.key} = ${setting.value ?? '(unset)'}  [${where}]`);
  }
  return lines;
}
