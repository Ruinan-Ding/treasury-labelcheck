// Sarah Chen's interview puts peak-season importer dumps at 200-300 applications at once,
// so the cap is set above the largest batch she described rather than below it.
export const MAX_BATCH_SIZE = 300;
export const DEFAULT_CONCURRENCY = 3;

export async function processBatch<T, R>(
  cases: T[],
  processor: (item: T) => Promise<R> | R,
  concurrency = DEFAULT_CONCURRENCY
): Promise<R[]> {
  const queue = cases.slice(0, MAX_BATCH_SIZE);
  const results: R[] = new Array(queue.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), queue.length || 1);

  async function worker(): Promise<void> {
    while (nextIndex < queue.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await processor(queue[currentIndex]);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
