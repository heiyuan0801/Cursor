import { describe, expect, test, vi } from "vitest";
import { anthropicSseResponse, notifyStreamError } from "./streaming";
import { anthropicSseEvents } from "./anthropic";
import type { CursorTextEvent } from "../core/cursor";
describe("streaming failure and backpressure", () => {
  test("conversation persistence completes before a terminal Anthropic event", async () => {
    let saved = false;
    async function* upstream(): AsyncIterable<CursorTextEvent> {
      yield { type: "text", text: "hello" };
      yield { type: "done" };
    }
    const events = anthropicSseEvents({
      id: "msg_test",
      model: "auto",
      inputTokens: 1,
      stream: upstream(),
      tools: [],
      onDone: async () => {
        await Promise.resolve();
        saved = true;
      },
    });
    for await (const event of events) {
      if (event.event === "message_delta" || event.event === "message_stop")
        expect(saved).toBe(true);
    }
    expect(saved).toBe(true);
  });
  test("still emits an error frame when persisting model failure fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      async function* fail() {
        throw new Error("upstream failed");
        yield { event: "unused", data: {} };
      }
      const response = anthropicSseResponse(fail(), async () => {
        throw new Error("database offline");
      });
      const body = await response.text();
      expect(body).toContain("event: error");
      expect(body).toContain("upstream failed");
      expect(body).not.toContain("database offline");
    } finally {
      log.mockRestore();
    }
  });
  test("does not eagerly drain the upstream generator and cancels it", async () => {
    let produced = 0,
      closed = false;
    async function* events() {
      try {
        for (let i = 0; i < 1000; i++) {
          produced++;
          yield { event: "delta", data: { text: "token" } };
        }
      } finally {
        closed = true;
      }
    }
    const response = anthropicSseResponse(events());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(produced).toBeLessThanOrEqual(1);
    await response.body!.cancel();
    expect(closed).toBe(true);
    expect(produced).toBeLessThanOrEqual(1);
  });
  test("handles synchronous failure callbacks", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        notifyStreamError(() => {
          throw new Error("failed");
        }, new Error("upstream")),
      ).resolves.toBeUndefined();
    } finally {
      log.mockRestore();
    }
  });
});
