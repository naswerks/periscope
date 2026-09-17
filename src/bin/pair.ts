/**
 * `periscope pair <code> [--controller <origin>] [--label <name>]` — trade a short-lived pair code
 * for this machine's durable credential, and learn where the controller is from its answer.
 *
 * Why this is a command rather than something the daemon does: the same reason `login` is. The
 * code is single-use and expires in minutes (it is a deliberate act a person performs once) and
 * the daemon must never block on anything interactive. After this succeeds, the daemon reads the
 * written file forever; after the controller revokes it, the daemon's next dial dies loudly and
 * the fix is to run this again with a fresh code.
 *
 * It writes the same protected directory the daemon reads, derived from the same call:
 * `pairedCredentialPath(env)`, beside the token cache, inside the gate's protected set. Nothing
 * here computes a path of its own.
 *
 * Where the redemption door is: `--controller`'s origin when given; else `PERISCOPE_PAIR_URL` when
 * set; otherwise derived from `PERISCOPE_DECISION_URL`'s origin (the one controller URL every
 * configured host already has) plus the controller's published redemption route. The derivation is
 * stated here once so a controller that moves the route has one line to argue with.
 *
 * What the controller answers with, beyond the credential: the URLs this host should dial
 * (`controllerUrl`, `decisionUrl`). The controller names its own routes; this command hardcodes only
 * the pair route above. When both arrive they are written to the config file beside the credential,
 * so a machine paired with one command needs nothing else before `serve`. The environment still
 * wins per key, and the write says so when it is shadowed.
 */
import { certificateRemedy, describeFailure, isCertificateRefusal } from '../core/failure.js';
import { writeConfigEntries } from '../host/config-file.js';
import { readMachineFacts } from '../host/machine.js';
import { pairedCredentialPath } from '../host/paths.js';
import { FilePairedCredential } from '../host/paired-credential-store.js';
import type { PairedCredentialStore } from '../identity/paired-credential.js';

const REDEMPTION_ROUTE = '/api/periscope/pair';

/** The two flags: null means "not given", and the environment path applies. */
export interface PairAsk {
  readonly controller?: string | null;
  readonly label?: string | null;
}

/** The verb's outcome: plain, CLI-local, and deliberately not the wire's refusal vocabulary.
 * Nothing here crosses the link, so nothing here may widen it. */
export type PairOutcome =
  | { readonly ok: true; readonly hostId: string; readonly path: string }
  | { readonly ok: false; readonly detail: string };

/** The edges, injected so the whole verb is testable without a controller or a disk. */
export interface PairDeps {
  /** Where operator-facing lines go. Defaults to stdout. */
  readonly write?: (line: string) => void;
  /** The HTTP edge. Defaults to global fetch. */
  readonly transport?: typeof fetch;
  /** Replaced in tests so nothing touches the real credential path. */
  readonly store?: (path: string) => PairedCredentialStore;
}

/** Run the pair command. Returns rather than exits, so the caller owns the process. */
export async function runPair(
  code: string | null,
  env: NodeJS.ProcessEnv,
  deps: PairDeps = {},
  asked: PairAsk = {},
): Promise<PairOutcome> {
  const write = deps.write ?? ((line: string) => process.stdout.write(`${line}\n`));

  if (code === null) {
    return {
      ok: false,
      detail: 'no code given - usage: periscope pair <code> [--controller <origin>] [--label <name>]',
    };
  }

  const url = redemptionUrl(env, asked.controller ?? null);
  if (url === null) {
    return {
      ok: false,
      detail:
        asked.controller === undefined || asked.controller === null
          ? 'nowhere to redeem the code - pass --controller <origin>, or set PERISCOPE_PAIR_URL or PERISCOPE_DECISION_URL (whose origin names the controller)'
          : `--controller '${asked.controller}' is not an http(s) URL`,
    };
  }

  const path = pairedCredentialPath(env);
  if (path === null) {
    return {
      ok: false,
      detail:
        'nowhere to keep the credential - set PERISCOPE_CONFIG_DIR or run as a user with a home directory',
    };
  }

  // The label the operator will recognize this machine by in every listing. Overridable because a
  // hostname like `DESKTOP-4F7Q2` recognizes nobody.
  const machineLabel = asked.label ?? env['PERISCOPE_MACHINE_LABEL'] ?? readMachineFacts().hostname;

  const transport = deps.transport ?? fetch;
  let response: Response;
  try {
    response = await transport(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, machineLabel }),
    });
  } catch (error) {
    // The cause, not the wrapper: `fetch failed` over a refused certificate is not "unreachable", and
    // a reader told the controller is down will not look at the certificate.
    const why = describeFailure(error);
    return {
      ok: false,
      detail: isCertificateRefusal(error)
        ? `the controller at ${url} presented a certificate Node refused (${why}). ${certificateRemedy('the controller')}`
        : `the controller at ${url} could not be reached - ${why}`,
    };
  }

  if (response.status === 404 || response.status === 405) {
    // Nothing at this route is a wrong door, not a refused code: the origin is not a controller,
    // or its pair route is elsewhere. Saying "mint a fresh code" here sends the reader to the
    // wrong fix.
    return {
      ok: false,
      detail:
        `nothing answers the pair route at ${url} (HTTP ${response.status}). Check --controller (an ` +
        'http(s) origin) or PERISCOPE_PAIR_URL; a controller redeems codes at its own pair route.',
    };
  }
  if (!response.ok) {
    // The door's one refusal is deliberate (unknown, expired and consumed answer identically);
    // the honest instruction is therefore always the same: mint a fresh code.
    const body = await response.text().catch(() => '');
    return {
      ok: false,
      detail:
        `the controller refused this code (HTTP ${response.status}${body === '' ? '' : ` - ${body}`}). ` +
        'Codes are single-use and expire in minutes; mint a fresh one and try again.',
    };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return {
      ok: false,
      detail: 'the controller answered success with an unreadable body - nothing was written',
    };
  }

  const record = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  const hostId = record['hostId'];
  const credential = record['hostCredential'];
  if (typeof hostId !== 'string' || hostId === '' || typeof credential !== 'string' || credential === '') {
    return {
      ok: false,
      detail: 'the controller answered success without a credential - nothing was written',
    };
  }
  // The shape is the contract: `serve` reads the host id out of the credential and refuses a file
  // whose two copies disagree, so a credential that would be refused at the next start is refused
  // here, where the fix (the controller's answer) is nameable.
  if (!credential.startsWith(`p1.${hostId}.`) || credential.length <= `p1.${hostId}.`.length) {
    return {
      ok: false,
      detail:
        `the controller answered a credential that does not have the shape p1.<hostId>.<secret> for ` +
        `host ${hostId} - nothing was written. A paired credential embeds the host id it speaks for.`,
    };
  }

  const store = (deps.store ?? ((p: string) => new FilePairedCredential(p)))(path);
  const written = store.write({ hostId, credential });
  if (!written.ok) {
    return { ok: false, detail: `${written.refusal.reason} - ${written.refusal.detail}` };
  }

  write(`paired as ${hostId}; credential written to ${path}`);
  write('this host now dials with the paired credential - the sign-in token expiry no longer applies to it');

  // The controller names where this host should dial. Written after the credential, never instead
  // of it: the credential is the scarce thing, and a config write that fails is reported, not a
  // reason to lose what was just minted.
  const controllerUrl = record['controllerUrl'];
  const decisionUrl = record['decisionUrl'];
  if (
    typeof controllerUrl === 'string' &&
    controllerUrl !== '' &&
    typeof decisionUrl === 'string' &&
    decisionUrl !== ''
  ) {
    const problem = writeConfigEntries(env, [
      { key: 'PERISCOPE_CONTROLLER_URL', value: controllerUrl },
      { key: 'PERISCOPE_DECISION_URL', value: decisionUrl },
    ]);
    if (problem !== null) {
      write(`the controller's addresses were not written to the config file - ${problem}`);
    } else {
      write(
        `PERISCOPE_CONTROLLER_URL and PERISCOPE_DECISION_URL written to the config file - serve needs nothing else`,
      );
      for (const key of ['PERISCOPE_CONTROLLER_URL', 'PERISCOPE_DECISION_URL'] as const) {
        const fromEnv = env[key];
        if (fromEnv !== undefined && fromEnv !== '') {
          write(
            `note: ${key} is set in the environment, and the environment wins - the file value is a fallback`,
          );
        }
      }
    }
  } else {
    write(
      'the controller did not name its link and decision URLs - set PERISCOPE_CONTROLLER_URL and PERISCOPE_DECISION_URL before serve',
    );
  }
  return { ok: true, hostId, path };
}

/**
 * The redemption door's address. `PERISCOPE_PAIR_URL` verbatim when set; otherwise the decision
 * URL's origin + the controller's published route. The decision URL is required configuration for
 * every serving host, so a machine being paired on the box it will serve from has nothing extra to
 * set.
 */
function redemptionUrl(env: NodeJS.ProcessEnv, controller: string | null): string | null {
  if (controller !== null) {
    try {
      const parsed = new URL(controller);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      return `${parsed.origin}${REDEMPTION_ROUTE}`;
    } catch {
      return null;
    }
  }

  const explicit = env['PERISCOPE_PAIR_URL'];
  if (explicit !== undefined && explicit !== '') return explicit;

  const decision = env['PERISCOPE_DECISION_URL'];
  if (decision === undefined || decision === '') return null;

  try {
    return `${new URL(decision).origin}${REDEMPTION_ROUTE}`;
  } catch {
    return null;
  }
}
