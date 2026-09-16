/**
 * The pure core: no `node:` imports, no packages, no I/O.
 *
 * Pinned by src/pins/core-purity.test.ts. The point is that anything here runs anywhere — in the
 * host, in a controller, in a browser — so the contract types can be shared without dragging a
 * runtime along with them.
 */
export type { Refusal, RefusalReason } from './refusal.js';
export { REFUSAL_REASONS, isRefusalReason, refusal } from './refusal.js';

export type { Result } from './result.js';
export { isOk, ok, refuse, valueOr } from './result.js';

export type { HostNoun, SdkNoun } from './vocab.js';
export { HOST_NOUNS, SDK_NOUNS, isDeclaredNoun, nounOf } from './vocab.js';

export { isAbsolutePath, isContainedBy, normalizePath, requireAbsolute } from './paths.js';

export { MAX_WORKSPACE_ID_LENGTH } from './workspace-id.js';

export type { Clock, Ticker } from './time.js';
export { fixedClock, fixedTicker, systemClock, systemTicker } from './time.js';
