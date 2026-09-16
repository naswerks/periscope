/**
 * Run options for the fast-check properties. The suite pins a seed so a pull-request run is
 * reproducible; exploration with fresh seeds is the weekly job's, or a developer's with
 * `PERISCOPE_FC_SEED=random`. A number in that variable reproduces a reported failure.
 */
export interface PropertyRuns {
  readonly numRuns: number;
  readonly seed?: number;
}

const DEFAULT_SEED = 20260908;

export function propertyRuns(numRuns = 200): PropertyRuns {
  const seed = process.env['PERISCOPE_FC_SEED'];
  if (seed === 'random') return { numRuns };
  if (seed === undefined || seed === '') return { numRuns, seed: DEFAULT_SEED };
  const parsed = Number(seed);
  return { numRuns, seed: Number.isFinite(parsed) ? parsed : DEFAULT_SEED };
}
