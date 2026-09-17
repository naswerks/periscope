/**
 * Asking a controller. The one place this package makes an outbound decision request.
 *
 * The status is discriminated before the body is read, and that order is the whole file. A client
 * that parses first and branches second turns a 500 carrying a perfectly valid problem-details body
 * into an object with no `allow` field, whose falsy value renders as a refusal somebody made. That
 * is a controller outage impersonating a human decision — nobody had said no, and the trace said
 * somebody had. Reading `status` first makes that shape unwritable.
 *
 * The transport is injected and structural. A minimal `{status, text()}` shape rather than the DOM
 * `Response` type: the global `fetch` satisfies it, a test double satisfies it without a server, and
 * nothing here acquires a dependency on a browser lib for a package that runs on a server.
 */
import { certificateRemedy, describeFailure, isCertificateRefusal } from '../core/failure.js';
import type { ControllerCredential } from '../control/credential.js';
import type { Decider, DecisionRequest } from './decision.js';

/** Just enough of a response to decide on it. `fetch`'s own `Response` satisfies this. */
export interface EscalationResponse {
  readonly status: number;
  text(): Promise<string>;
}

export type EscalationTransport = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body: string;
    readonly signal: AbortSignal;
  },
) => Promise<EscalationResponse>;

export interface EscalationOptions {
  /** Where the controller answers. Supplied by the embedder; never derived here. */
  readonly url: string;
  readonly transport: EscalationTransport;
  /** Sent verbatim, on every request. For a scheme whose value does not change. */
  readonly headers?: Record<string, string>;
  /**
   * The credential this host presents on each decision request. Resolved per request.
   *
   * Why it is a credential and not a header. The static `headers` above cannot carry a bearer
   * token: a token is refreshed on a schedule this module does not know, so a value captured once
   * would be presented for the life of the host and start failing silently at the first expiry —
   * as an outage, on every tool call, which is the failure shape this whole file is written against.
   * The same seam the link uses is asked again here, and it hands back a live value.
   *
   * Its failure posture is the opposite of the link's, deliberately. The link connects with no
   * headers when its credential refuses — a stated decision, on the ground that a version without
   * identity is better than one pretending to have a scheme. That reasoning does not transfer here.
   * The link carries observations; this endpoint decides whether a tool runs. An unauthenticated
   * request to it is an unauthenticated permission decision, and anyone who can reach the URL can
   * answer for the agent. So a credential that refuses is an outage and the tool does not run — the
   * gate's own invariant, applied to the gate's own transport. Two transports, two postures, and the
   * difference is what each one can be used to do.
   *
   * Absent means no credential is presented, which is the previous behaviour and stays available for
   * an embedder whose endpoint is reachable only from inside its own network.
   *
   * The precondition: a credential that refuses is not a quieter credential — it is an outage on
   * every tool call, so the option must be omitted rather than filled with a placeholder when there
   * is no identity. `bin/periscope.ts` does exactly that, and the composition is the contract.
   *
   * What this package can present is narrower than what a controller may require. `identity/`
   * implements the authorization-code, refresh-token and device-code grants — every one of which
   * mints a delegated user token. There is no client-credentials grant here, so this host cannot
   * obtain an app-only token at all, and `Authorization` carries one header, so it cannot present a
   * second scheme selector alongside the bearer. A controller that admits only a machine app role
   * therefore refuses both postures — a configured host with a user token and an unconfigured host
   * with none — and it refuses them at the door, fail-closed. Nothing in this file grants this host
   * a machine identity, and a reader should not infer from the presence of this option that one
   * exists.
   */
  readonly credential?: ControllerCredential;
}

/**
 * Thrown for every way the ask failed, as distinct from a decision that said no.
 *
 * It is an error rather than a returned value because the gate's contract is that the decider
 * returns whatever the controller said; "the controller said nothing" is not something it said.
 * The gate turns this into `permission-decision-unavailable` — an outage, never a denial.
 */
export class EscalationUnavailable extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'EscalationUnavailable';
  }
}

/**
 * A decider that asks a controller over HTTP.
 *
 * Returns the parsed body as `unknown`: reading it as a decision is `readDecision`'s job, and a
 * well-formed answer this build does not recognise must reach the gate to be refused by the gate.
 *
 * The two failure kinds are split on purpose, and the split is not obvious.
 *   - A non-2xx, a transport error, or a body that is not JSON is an outage. The controller did not
 *     answer, or answered something that is not an answer. A controller-side fix.
 *   - Valid JSON that is not a decision this build knows is not handled here. It is returned intact
 *     and the gate refuses it as unrecognised. A controller-version fix.
 * Malformed JSON is an outage rather than an unrecognised decision because version skew produces a
 * *different* decision, never a broken one.
 */
export function escalatingDecider(options: EscalationOptions): Decider {
  return async (request: DecisionRequest, signal: AbortSignal): Promise<unknown> => {
    // ---- The credential, before the request exists. A refusal here never becomes a request: an
    // unauthenticated ask is not a quieter version of an authenticated one, it is a different act.
    const authorization: Record<string, string> = {};
    if (options.credential !== undefined) {
      const authorized = await options.credential.authorize();
      if (!authorized.ok) {
        throw new EscalationUnavailable(
          `this host has no credential to present on a decision request for ${request.toolName} ` +
            `(${authorized.refusal.reason}: ${authorized.refusal.detail}). The request was NOT sent: ` +
            `an unauthenticated permission decision is one anybody who can reach the endpoint could ` +
            `answer, so the gate treats this as an outage and the tool does not run`,
        );
      }
      authorization[authorized.value.header] = authorized.value.value;
    }

    let response: EscalationResponse;
    try {
      response = await options.transport(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(options.headers ?? {}), ...authorization },
        body: JSON.stringify(request),
        signal,
      });
    } catch (error) {
      const why = describeFailure(error);
      throw new EscalationUnavailable(
        isCertificateRefusal(error)
          ? `the decision request to ${options.url} was refused at TLS (${why}). ${certificateRemedy('the decision endpoint')}`
          : `the decision request to ${options.url} did not complete: ${why}`,
      );
    }

    // ---- Status first. Nothing below this line has read the body. ----
    if (response.status < 200 || response.status >= 300) {
      throw new EscalationUnavailable(
        `the controller answered ${response.status} to a decision request for ${request.toolName}; ` +
          'the body was not read, because a body that parses is not an answer that was given',
      );
    }

    let body: string;
    try {
      body = await response.text();
    } catch (error) {
      throw new EscalationUnavailable(`the decision response body could not be read: ${String(error)}`);
    }

    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new EscalationUnavailable(
        `the controller answered ${response.status} with a body that is not JSON (${body.length} bytes)`,
      );
    }
  };
}
