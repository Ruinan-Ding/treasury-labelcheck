import { describe, expect, it } from "vitest";
import { DEFAULT_CONCURRENCY, MAX_BATCH_SIZE, processBatch } from "./batch";

describe("processBatch", () => {
  it("preserves input order while processing work concurrently", async () => {
    let active = 0;
    let peak = 0;

    const results = await processBatch([1, 2, 3, 4, 5], async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return value * 2;
    });

    expect(results).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBeLessThanOrEqual(DEFAULT_CONCURRENCY);
  });

  it("caps oversized uploads at the configured batch limit", async () => {
    const input = Array.from({ length: MAX_BATCH_SIZE + 7 }, (_, index) => index);
    const results = await processBatch(input, (value) => value);

    expect(results).toHaveLength(MAX_BATCH_SIZE);
    expect(results[results.length - 1]).toBe(MAX_BATCH_SIZE - 1);
  });

  it("propagates processor errors instead of silently converting them to success", async () => {
    await expect(processBatch(["valid", "invalid"], (value) => {
      if (value === "invalid") throw new Error("invalid input");
      return value;
    })).rejects.toThrow("invalid input");
  });
});
