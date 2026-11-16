/**
 * The tasks budget: a `tasks` fact, as JSON, takes at most `MAX_TASKS_FACT_BYTES`, so the fact and its
 * envelope always fit a frame.
 *
 * A `tasks` fact is the whole running set and the whole settled set, replaced on every send, and each
 * entry carries text a runtime wrote (a description, a summary, a path). Each text is held to its own
 * bound, but a session that ran many tasks holds many of them, and a fact past the frame is one the
 * codec refuses: nothing about any task would arrive. Every lift hands its two lists through `fitTasks`
 * before it builds the fact, so a fact past the budget is cut here, once, by one rule:
 *   - each list is held to `MAX_FACT_LIST_ENTRIES`, the newest settled entries kept;
 *   - then text is cut. Every text longer than one length is cut to it, and that length is the longest
 *     at which the fact fits, so the longest texts give first and a short one gives nothing;
 *   - only when every text is down to `SHORTEST_TASK_TEXT` are entries left out: the oldest settled
 *     first, and a running task only after every settled one has gone.
 * An id is never cut: half an id names nothing. Lists that fit are returned as they were given.
 *
 * Pure, and free of any runtime: it measures as the item budget does, with `TextEncoder`.
 */
import type { RunningTaskEntry, SettledTaskEntry, TaskReport } from './frames.js';
import { MAX_FACT_LIST_ENTRIES, MAX_FACT_TEXT_LENGTH } from './frames.js';
import { cutText } from './fact-text.js';
import { agentItemBytes } from './item-budget.js';

/**
 * The most bytes a `tasks` fact's two lists take as JSON. Three quarters of a frame, so the fact, its
 * kind and runtime and the frame around it always fit `MAX_FRAME_BYTES`.
 */
export const MAX_TASKS_FACT_BYTES = 48 * 1024;

/** The shortest a task's text is cut to before an entry is left out instead. */
export const SHORTEST_TASK_TEXT = 16;

/** The two lists of a `tasks` fact, within the budget. */
export interface FittedTasks {
  readonly running: readonly RunningTaskEntry[];
  readonly settled: readonly SettledTaskEntry[];
}

/** `entry` with each text longer than `length` cut to it; the same object when none is. */
function withTextsAt<T extends TaskReport & { readonly description?: string | null }>(
  entry: T,
  length: number,
): T {
  const over = (text: string | null | undefined): text is string =>
    typeof text === 'string' && text.length > length;
  if (!over(entry.description) && !over(entry.summary) && !over(entry.outputFile)) return entry;
  return {
    ...entry,
    ...(over(entry.description) ? { description: cutText(entry.description, length) } : {}),
    ...(over(entry.summary) ? { summary: cutText(entry.summary, length) } : {}),
    ...(over(entry.outputFile) ? { outputFile: cutText(entry.outputFile, length) } : {}),
  };
}

/** The lists with every text held to `length`. */
function textsAt(tasks: FittedTasks, length: number): FittedTasks {
  return {
    running: tasks.running.map((entry) => withTextsAt(entry, length)),
    settled: tasks.settled.map((entry) => withTextsAt(entry, length)),
  };
}

function fits(tasks: FittedTasks): boolean {
  return agentItemBytes(tasks) <= MAX_TASKS_FACT_BYTES;
}

/**
 * `running` and `settled` within the tasks budget: unchanged when they fit, else cut by the rule in this
 * file's header.
 */
export function fitTasks(
  running: readonly RunningTaskEntry[],
  settled: readonly SettledTaskEntry[],
): FittedTasks {
  const listed: FittedTasks = {
    running: running.length > MAX_FACT_LIST_ENTRIES ? running.slice(0, MAX_FACT_LIST_ENTRIES) : running,
    settled: settled.length > MAX_FACT_LIST_ENTRIES ? settled.slice(-MAX_FACT_LIST_ENTRIES) : settled,
  };
  if (fits(listed)) return listed;

  const shortest = textsAt(listed, SHORTEST_TASK_TEXT);
  if (fits(shortest)) {
    // The longest length every text can keep: cutting further never makes the fact larger.
    let low = SHORTEST_TASK_TEXT;
    let high = MAX_FACT_TEXT_LENGTH;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(textsAt(listed, middle))) low = middle;
      else high = middle - 1;
    }
    return textsAt(listed, low);
  }

  // No text is left to cut. Each entry leaves with its own bytes and the comma beside it.
  const keptRunning = [...shortest.running];
  const keptSettled = [...shortest.settled];
  let bytes = agentItemBytes(shortest);
  while (bytes > MAX_TASKS_FACT_BYTES && keptSettled.length > 0) {
    bytes -= agentItemBytes(keptSettled.shift()) + 1;
  }
  while (bytes > MAX_TASKS_FACT_BYTES && keptRunning.length > 0) {
    bytes -= agentItemBytes(keptRunning.pop()) + 1;
  }
  return { running: keptRunning, settled: keptSettled };
}
