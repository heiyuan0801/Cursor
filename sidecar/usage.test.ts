import { describe, expect, test } from "bun:test";

import { UsageStore } from "./usage";

describe("usage store", () => {
  test("keeps the reported tokens, cache rate, TTFT and speed", async () => {
    const store = new UsageStore();
    const record = store.start({ endpoint: "chat", model: "claude-sonnet-5", promptChars: 400, stream: true });

    record.markFirstToken();
    await new Promise((resolve) => setTimeout(resolve, 25));
    record.finish({
      status: "completed",
      completionChars: 1200,
      usage: { inputTokens: 300, outputTokens: 900, cacheReadTokens: 700, cacheWriteTokens: 0, totalTokens: 1900 }
    });

    const [entry] = store.list();
    expect(entry.status).toBe("completed");
    expect(entry.estimated).toBe(false);
    expect(entry.inputTokens).toBe(300);
    expect(entry.outputTokens).toBe(900);
    expect(entry.cacheReadTokens).toBe(700);
    expect(entry.cacheHitRate).toBeCloseTo(700 / 1000, 6);
    expect(entry.firstTokenMs).not.toBeNull();
    expect(entry.durationMs).toBeGreaterThan(0);
    expect(entry.tokensPerSecond).toBeGreaterThan(0);
    expect(entry.totalCost).toBeGreaterThan(0);

    const stats = store.statistics();
    expect(stats.totalRequests).toBe(1);
    expect(stats.completedRequests).toBe(1);
    expect(stats.inputTokens).toBe(300);
    expect(stats.outputTokens).toBe(900);
    expect(stats.cacheReadTokens).toBe(700);
    expect(stats.averageTokensPerSecond).toBeGreaterThan(0);
    expect(stats.averageFirstTokenMs).not.toBeNull();
    expect(stats.averageCacheHitRate).toBeCloseTo(0.7, 6);
    expect(stats.modelBreakdown[0]).toMatchObject({ model: "claude-sonnet-5", requests: 1, outputTokens: 900 });
  });

  test("estimates tokens when Cursor reports no usage", () => {
    const store = new UsageStore();
    const record = store.start({ endpoint: "chat", model: "claude-sonnet-5", promptChars: 400, stream: false });
    record.finish({ status: "completed", completionChars: 800 });

    const [entry] = store.list();
    expect(entry.estimated).toBe(true);
    expect(entry.inputTokens).toBe(100);
    expect(entry.outputTokens).toBe(200);
    expect(entry.totalTokens).toBe(300);
    expect(entry.totalCost).toBeGreaterThan(0);
    expect(store.statistics().estimatedRequests).toBe(1);
  });

  test("records failures once and filters by status and model", () => {
    const store = new UsageStore();
    const failed = store.start({ endpoint: "chat", model: "gpt-5.6-sol", promptChars: 10, stream: true });
    failed.finish({ status: "error", error: new Error("upstream exploded") });
    failed.finish({ status: "completed", completionChars: 999 });

    const ok = store.start({ endpoint: "responses", model: "claude-sonnet-5", promptChars: 10, stream: false });
    ok.finish({ status: "completed", completionChars: 40 });

    expect(store.list({ status: "error" })).toHaveLength(1);
    expect(store.list({ status: "error" })[0].error).toBe("upstream exploded");
    expect(store.list({ model: "claude-sonnet-5" })).toHaveLength(1);
    expect(store.list({ endpoint: "responses" })).toHaveLength(1);

    const stats = store.statistics();
    expect(stats.totalRequests).toBe(2);
    expect(stats.failedRequests).toBe(1);
    expect(stats.completedRequests).toBe(1);
  });

  test("newest first, and never grows past the limit", () => {
    const store = new UsageStore("", 2);
    for (const model of ["a", "b", "c"]) {
      store.start({ endpoint: "chat", model, promptChars: 1, stream: false }).finish({ status: "completed", completionChars: 1 });
    }
    expect(store.list().map((entry) => entry.model)).toEqual(["c", "b"]);
  });
});
