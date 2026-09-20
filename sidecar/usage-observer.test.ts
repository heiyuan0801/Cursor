import { describe, expect, test, vi } from "vitest";
import { observeUsage, registerResponseUsage } from "./usage-observer";

describe("bounded streaming usage accounting", () => {
  test("accounts internal usage even when the client omits include_usage", async () => {
    const source = new Response("data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
    registerResponseUsage(source, () => ({
      input_tokens: 12,
      output_tokens: 3,
    }));
    const finish = vi.fn(async () => {});
    expect(await observeUsage(source, finish).text()).toBe("data: [DONE]\n\n");
    expect(finish).toHaveBeenCalledExactlyOnceWith(
      { input_tokens: 12, output_tokens: 3 },
      null,
    );
  });
  test("preserves JSON bytes and nested Responses usage", async () => {
    const text = JSON.stringify({
      response: { usage: { input_tokens: 12, output_tokens: 8 } },
    });
    const finish = vi.fn(async () => {});
    const result = observeUsage(new Response(text), finish);
    expect(await result.text()).toBe(text);
    expect(finish).toHaveBeenCalledExactlyOnceWith(
      { input_tokens: 12, output_tokens: 8 },
      null,
    );
  });
  test("merges Anthropic usage over fragmented SSE frames, including Unicode", async () => {
    const text =
      'data: {"message":{"content":"你好","usage":{"input_tokens":10,"cache_read_input_tokens":8}}}\n\n' +
      'data: {"usage":{"output_tokens":4}}\n\ndata: [DONE]\n\n';
    const bytes = new TextEncoder().encode(text);
    let index = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(c) {
        if (index === bytes.length) c.close();
        else c.enqueue(bytes.slice(index, (index += 1)));
      },
    });
    const finish = vi.fn(async () => {});
    expect(
      await observeUsage(
        new Response(source, {
          headers: { "content-type": "text/event-stream" },
        }),
        finish,
      ).text(),
    ).toBe(text);
    expect(finish).toHaveBeenCalledExactlyOnceWith(
      { input_tokens: 10, cache_read_input_tokens: 8, output_tokens: 4 },
      null,
    );
  });
  test("records HTTP and SSE errors without replacing the response", async () => {
    const finish = vi.fn(async () => {});
    const text =
      'data: {"type":"response.failed","response":{"error":{"message":"bad"}}}\n\n';
    expect(
      await observeUsage(
        new Response(text, {
          headers: { "content-type": "text/event-stream" },
        }),
        finish,
      ).text(),
    ).toBe(text);
    expect(finish).toHaveBeenCalledWith(null, "Upstream stream failed");
    const http = vi.fn(async () => {});
    expect(
      await observeUsage(new Response("{}", { status: 401 }), http).text(),
    ).toBe("{}");
    expect(http).toHaveBeenCalledWith(null, "HTTP 401");
  });
  test("cancellation is accounted exactly once", async () => {
    const finish = vi.fn(async () => {});
    const response = observeUsage(
      new Response(new ReadableStream({ pull() {} })),
      finish,
    );
    await response.body!.cancel();
    expect(finish).toHaveBeenCalledExactlyOnceWith(null, "Client disconnected");
  });
  test("oversized bodies are passed through without retaining them for parsing", async () => {
    const text = "x".repeat(3 * 1024 * 1024);
    const finish = vi.fn(async () => {});
    expect(await observeUsage(new Response(text), finish).text()).toBe(text);
    expect(finish).toHaveBeenCalledExactlyOnceWith(null, null);
  });
});
