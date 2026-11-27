/** The slowest machine the scaled limits will follow; a larger measured factor is clamped to this value. */
export const MAX_SPEED_FACTOR = 8;

export interface ScaledLimit {
  limitMs: number;
  factor: number;
  referenceMs: number;
}

export function bestOfMs(task: () => unknown, attempts = 3): number {
  let best = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const started = performance.now();
    task();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

/** Scales a fixed limit by how slow this machine is: a realistic reference workload is timed in-process and the limit grows by its ratio.
 * The factor is clamped to `maxFactor` so a real regression that also slows the reference still fails instead of being cancelled out. */
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
 * Linear work stays near 2x, quadratic reaches 4x. The small time is floored at `floorMs` so a sub-millisecond baseline
 * cannot make a noisy ratio; a missed round is measured again, but the limit itself never moves.
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
