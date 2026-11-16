/**
 * The transition budget: a state transition, as JSON, takes at most `MAX_TRANSITION_BYTES`, so its update
 * and the frame around it always fit `MAX_FRAME_BYTES`.
 *
 * A transition's cause carries a detail for a person to read, and the detail of a failure is the failure's
 * own words: a stack, a response body, a list of paths. Nothing else bounds it, and a transition past the
 * frame is one the codec refuses, so the transition itself would never arrive, and the one a long detail
 * rides on is most often the session's `errored`. Every transition is handed through `fitTransition`
 * before it is sent. One that fits is sent as it is. One that does not has its detail cut by as much as
 * it is over and no more, and says that it was cut.
 *
 * Pure, and free of any runtime: it measures as the item budget does, with `TextEncoder`.
 */
import type { SessionTransition } from '../state/model.js';
import { cutText } from './fact-text.js';
import { agentItemBytes } from './item-budget.js';

/** The most bytes a transition takes as JSON. Three quarters of a frame, as the tasks budget is. */
export const MAX_TRANSITION_BYTES = 48 * 1024;

/** What a cut detail ends with, so a reader knows its words stop short. */
export const TRANSITION_DETAIL_CUT = ' [cut to fit a frame]';

/**
 * `transition` within the budget: the same object when it fits, else one whose cause's detail is the
 * longest beginning of the original that fits, followed by `TRANSITION_DETAIL_CUT`.
 */
export function fitTransition(transition: SessionTransition): SessionTransition {
  if (agentItemBytes(transition) <= MAX_TRANSITION_BYTES) return transition;
  const detail = transition.cause.detail;
  const cutAt = (length: number): SessionTransition => ({
    ...transition,
    cause: { ...transition.cause, detail: `${cutText(detail, length)}${TRANSITION_DETAIL_CUT}` },
  });
  let low = 0;
  let high = detail.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (agentItemBytes(cutAt(mid)) <= MAX_TRANSITION_BYTES) low = mid;
    else high = mid - 1;
  }
  return cutAt(low);
}
