/** The slowest machine the scaled limits will follow; a larger measured factor is clamped to this value. */
export const MAX_SPEED_FACTOR = 8;

export interface ScaledLimit {
  /** The limit to assert against: `limitMs` times the clamped machine factor. */
  limitMs: number;
  /** How many times slower than `referenceBudgetMs` the reference workload ran, never below 1 and never above the cap. */
  factor: number;
  /** The reference workload's best time on this machine. */
  referenceMs: number;
}

/** The fastest of `attempts` timed runs, in milliseconds. The best run drops GC pauses and scheduler noise. */
export function bestOfMs(task: () => unknown, attempts = 3): number {
  let best = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const started = performance.now();
    task();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

/**
 * Scales a fixed time limit by how slow this machine is right now.
 *
 * A fixed millisecond limit is written for an ordinary machine and flakes under v8 coverage instrumentation or on a
 * loaded CI runner. `reference` must be a realistic, non-adversarial workload of the same size that runs through the
 * same code path as the code under test; it is timed here in the same process, and when it takes longer than
 * `referenceBudgetMs` (its time on an ordinary machine, rounded up) the limit grows by that ratio.
 *
 * Why a real regression still fails: a quadratic slowdown on an adversarial shape costs seconds there while the
 * realistic reference does not move, so the limit stays put. A slowdown that also reaches the reference inflates the
 * factor, which is why the factor is clamped to `maxFactor`: the limit then stops following the reference and the
 * assertion fails instead of being cancelled out. Limits are never loosened below the written value (factor >= 1).
 */
export function scaledLimit(options: {
  limitMs: number;
  reference: () => unknown;
  referenceBudgetMs: number;
  attempts?: number;
  maxFactor?: number;
}): ScaledLimit {
  const { limitMs, reference, referenceBudgetMs, attempts = 3, maxFactor = MAX_SPEED_FACTOR } = options;
  // One untimed run warms up JIT and caches so the measurement is the steady state the code under test also sees.
  reference();
  const referenceMs = bestOfMs(reference, attempts);
  const factor = Math.min(maxFactor, Math.max(1, referenceMs / referenceBudgetMs));
  return { limitMs: limitMs * factor, factor, referenceMs };
}

/**
 * Times a workload and the same workload at twice the size, interleaved so a load spike hits both the same way, and
 * returns the best time of each. The small time is floored at `floorMs` so a sub-millisecond baseline cannot make a
 * noisy ratio. `withinLimit` is the caller's growth assertion (linear work stays near 2x, quadratic reaches 4x); a
 * round that misses it is measured again, up to `rounds` times, and the last round is returned for the assertion.
 * The limit itself never moves: quadratic work misses it in every round, while a GC pause or a busy neighbour in a
 * parallel test run rarely repeats.
 */
export function doublingGrowth(options: {
  small: () => unknown;
  large: () => unknown;
  floorMs: number;
  withinLimit: (smallMs: number, largeMs: number) => boolean;
  attempts?: number;
  rounds?: number;
}): {
  smallMs: number;
  largeMs: number;
} {
  const { small, large, floorMs, withinLimit, attempts = 3, rounds = 3 } = options;
  let measured = { smallMs: 0, largeMs: Number.POSITIVE_INFINITY };
  for (let round = 0; round < rounds; round += 1) {
    let smallMs = Number.POSITIVE_INFINITY;
    let largeMs = Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      smallMs = Math.min(smallMs, bestOfMs(small, 1));
      largeMs = Math.min(largeMs, bestOfMs(large, 1));
    }
    measured = { smallMs: Math.max(smallMs, floorMs), largeMs };
    if (withinLimit(measured.smallMs, measured.largeMs)) break;
  }
  return measured;
}
