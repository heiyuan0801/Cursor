import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalUsageStore } from "./test-helpers/legacy-usage";

describe("LocalUsageStore", () => {
  it("aggregates token/cost stats and removes logs before a cutoff", async () => {
    const store = new LocalUsageStore(join(mkdtempSync(join(tmpdir(), "cursor2api-usage-")), "usage.json"));
    await store.add({ endpoint: "/v1/chat/completions", model: "gpt-4o", status: "completed", usage: {
      prompt_tokens: 100, completion_tokens: 25, total_tokens: 125, cost: 0.02
    }, durationMs: 120 });
    const stats = await store.stats();
    expect(stats.totalRequests).toBe(1);
    expect(stats.totalTokens).toBe(125);
    expect(stats.totalCost).toBe(0.02);
    expect(await store.list()).toHaveLength(1);
    expect(await store.deleteBefore(new Date(Date.now() + 1000).toISOString())).toBe(1);
    expect(await store.list()).toHaveLength(0);
  });
});
