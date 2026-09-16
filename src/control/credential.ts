/**
 * The credential seam — deliberately empty.
 *
 * Identity is implemented in `identity/`, not here. This interface exists so the link has a shape
 * to call and the composition root has a slot to fill, and the only implementation here refuses by
 * name. It does
 * not read a worker key, invent a token format, or default to unauthenticated: a placeholder that
 * silently succeeds is how a scheme nobody designed ends up in production.
 */
import type { Result } from '../core/result.js';
import { refuse } from '../core/result.js';

/** What the link puts on the connect request, when there is something to put. */
export interface Authorization {
  readonly header: string;
  readonly value: string;
}

export interface ControllerCredential {
  authorize(): Promise<Result<Authorization>>;
}

/** The only implementation in this module. Refuses, and says which named way. */
export class UnconfiguredCredential implements ControllerCredential {
  authorize(): Promise<Result<Authorization>> {
    return Promise.resolve(
      refuse<Authorization>(
        'credential-unavailable',
        'no credential is configured; identity is not implemented in this layer',
      ),
    );
  }
}
