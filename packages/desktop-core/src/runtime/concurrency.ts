/**
 * Runs `worker` over `items` with at most `limit` in flight. After the first failure no new item starts, the running
 * ones finish, and that first failure is thrown. A `limit` that is not a positive integer throws a RangeError before
 * anything runs: with no worker lane the items would silently be skipped, and a caller that verifies files would pass.
 */
export async function forEachLimited<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`concurrency must be a positive integer, got ${String(limit)}`);
  }
  let next = 0;
  let failure: { readonly error: unknown } | undefined;
  const lane = async (): Promise<void> => {
    while (failure === undefined && next < items.length) {
      const item = items[next++] as T;
      try {
        await worker(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  if (failure !== undefined) throw failure.error;
}
