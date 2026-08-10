/**
 * Warranted — Concurrency utilities
 *
 * mapLimit: run async functions with a concurrency cap.
 * Default limit = 4, overridable via WARRANTED_REVIEW_CONCURRENCY env var.
 */

/**
 * Get the default concurrency limit from environment or fallback to 4.
 */
export function getDefaultLimit(): number {
  const env = process.env.WARRANTED_REVIEW_CONCURRENCY;
  if (env) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 4;
}

/**
 * Map an array of items through an async function with a concurrency limit.
 * Results are in input order, regardless of completion order.
 * Errors from individual items propagate up (the Promise rejects).
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number | undefined,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const effectiveLimit = limit ?? getDefaultLimit();
  if (items.length === 0) return [];

  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  let rejected = false;

  async function worker(): Promise<void> {
    while (nextIndex < items.length && !rejected) {
      const idx = nextIndex++;
      try {
        results[idx] = await fn(items[idx]);
      } catch (e) {
        rejected = true;
        throw e;
      }
    }
  }

  const workers: Promise<void>[] = [];
  const workerCount = Math.min(effectiveLimit, items.length);
  for (let i = 0; i < workerCount; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results;
}