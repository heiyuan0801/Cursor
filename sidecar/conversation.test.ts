import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  configureChatSessionStore,
  newTurnMessages,
} from "../core/chat-session";
import {
  conversationMessages,
  explicitConversationId,
  resolveGatewayConversation,
} from "./conversation";
import { sharedRedisFixture } from "./test-helpers/shared-redis";
import { optionsResponse } from "../core/http";

const request = (headers: Record<string, string> = {}) =>
  new Request("http://gateway.test/v1/chat/completions", { headers });
const opening = { messages: [{ role: "user", content: "hello" }] };
const followup = {
  messages: [
    ...opening.messages,
    { role: "assistant", content: "hi" },
    { role: "user", content: "next" },
  ],
};

describe("protocol-independent conversation identity", () => {
  test("browser preflight permits conversation headers", () => {
    const headers = optionsResponse()
      .headers.get("access-control-allow-headers")!
      .split(",");
    for (const name of [
      "x-session-affinity",
      "x-session-id",
      "x-opencode-session-id",
      "x-opencode-session",
    ])
      expect(headers).toContain(name);
  });
  beforeEach(() => configureChatSessionStore(sharedRedisFixture().cache));
  afterEach(() => {
    configureChatSessionStore();
    vi.useRealTimers();
  });
  test("explicit IDs are stable, hashed, protocol and client scoped", async () => {
    const first = await resolveGatewayConversation(
      request({ "x-session-affinity": "private-id" }),
      opening,
      "chat",
      "client-1",
    );
    const next = await resolveGatewayConversation(
      request({ "x-session-id": "private-id" }),
      followup,
      "chat",
      "client-1",
    );
    expect(next.affinity).toBe(first.affinity);
    expect(first.affinity).not.toContain("private-id");
    expect(first.affinity).not.toContain("client-1");
    expect(
      (
        await resolveGatewayConversation(
          request({ "x-session-id": "private-id" }),
          opening,
          "chat",
          "client-2",
        )
      ).affinity,
    ).not.toBe(first.affinity);
    expect(
      (
        await resolveGatewayConversation(
          request({ "x-session-id": "private-id" }),
          opening,
          "messages",
          "client-1",
        )
      ).affinity,
    ).not.toBe(first.affinity);
    expect(newTurnMessages(next.messages, next.resolution)).toEqual([
      { role: "user", content: "next" },
    ]);
  });
  test("supports known headers but never treats request idempotency as a conversation", () => {
    for (const name of [
      "x-session-affinity",
      "x-opencode-session-id",
      "x-opencode-session",
      "x-session-id",
    ])
      expect(explicitConversationId(request({ [name]: " session " }))).toBe(
        "session",
      );
    expect(
      explicitConversationId(request({ "idempotency-key": "one-request" })),
    ).toBeUndefined();
    expect(() =>
      explicitConversationId(request({ "x-session-id": "x".repeat(257) })),
    ).toThrow(/256/);
  });
  test("full transcript resumes automatically; duplicate continuation claims fork safely", async () => {
    const first = await resolveGatewayConversation(
      request(),
      opening,
      "chat",
      "client",
    );
    const independent = await resolveGatewayConversation(
      request(),
      opening,
      "chat",
      "client",
    );
    expect(independent.id).not.toBe(first.id);
    await first.remember("hi", []);
    const otherOwner = await resolveGatewayConversation(
      request(),
      followup,
      "chat",
      "other",
    );
    expect(otherOwner.resolution.resumed).toBe(false);
    const claims = await Promise.all(
      [1, 2].map(() =>
        resolveGatewayConversation(request(), followup, "chat", "client"),
      ),
    );
    expect(claims.filter((c) => c.id === first.id)).toHaveLength(1);
    expect(new Set(claims.map((c) => c.id)).size).toBe(2);
  });
  test("Anthropic tool-result followups preserve the conversation", async () => {
    const body = { model: "auto", max_tokens: 200, messages: opening.messages };
    const first = await resolveGatewayConversation(
      request(),
      body,
      "messages",
      "client",
    );
    await first.remember("", [
      { function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
    ]);
    const next = await resolveGatewayConversation(
      request(),
      {
        ...body,
        messages: [
          ...body.messages,
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool-1",
                name: "read_file",
                input: { path: "a.ts" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-1",
                content: "file contents",
              },
            ],
          },
        ],
      },
      "messages",
      "client",
    );
    expect(next.id).toBe(first.id);
    expect(newTurnMessages(next.messages, next.resolution)[0].role).toBe(
      "tool",
    );
  });
  test("Responses text plus function-call output normalizes to one assistant turn", async () => {
    const first = await resolveGatewayConversation(
      request(),
      { input: "hello" },
      "responses",
      "client",
    );
    await first.remember("checking", [
      { function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
    ]);
    const next = await resolveGatewayConversation(
      request(),
      {
        input: [
          { role: "user", content: [{ type: "input_text", text: "hello" }] },
          { type: "reasoning", summary: [] },
          {
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: "checking", annotations: [] },
            ],
          },
          {
            type: "function_call",
            call_id: "call-1",
            name: "read_file",
            arguments: '{"path":"a.ts"}',
          },
          {
            type: "function_call_output",
            call_id: "call-1",
            output: "contents",
          },
        ],
      },
      "responses",
      "client",
    );
    expect(next.id).toBe(first.id);
    expect(newTurnMessages(next.messages, next.resolution)).toEqual([
      { role: "tool", tool_call_id: "call-1", content: "contents" },
    ]);
  });
  test("different images must not resolve to the same transcript", async () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "https://example.test/a.png" },
            },
          ],
        },
      ],
    };
    const first = await resolveGatewayConversation(
      request(),
      body,
      "chat",
      "client",
    );
    await first.remember("image", []);
    const other = await resolveGatewayConversation(
      request(),
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: "https://example.test/b.png" },
              },
            ],
          },
          { role: "assistant", content: "image" },
          { role: "user", content: "next" },
        ],
      },
      "chat",
      "client",
    );
    expect(other.resolution.resumed).toBe(false);
    const next = await resolveGatewayConversation(
      request(),
      {
        messages: [
          ...body.messages,
          { role: "assistant", content: "image" },
          { role: "user", content: "next" },
        ],
      },
      "chat",
      "client",
    );
    expect(next.id).toBe(first.id);
  });
  test("changing system instructions or tool inventory changes SDK configuration, not explicit account affinity", async () => {
    const first = await resolveGatewayConversation(
      request({ "x-session-id": "same" }),
      opening,
      "chat",
      "client",
    );
    const changed = await resolveGatewayConversation(
      request({ "x-session-id": "same" }),
      {
        ...opening,
        tools: [{ type: "function", function: { name: "read_file" } }],
      },
      "chat",
      "client",
    );
    expect(changed.affinity).toBe(first.affinity);
    expect(changed.configuration).not.toBe(first.configuration);
  });
  test("configured recognition TTL expires even if the shared store retains a stale entry", async () => {
    const fixture = sharedRedisFixture();
    configureChatSessionStore(fixture.cache, 60);
    vi.useFakeTimers();
    const first = await resolveGatewayConversation(
      request(),
      opening,
      "chat",
      "client",
    );
    await first.remember("hi", []);
    vi.setSystemTime(Date.now() + 61000);
    expect(
      (await resolveGatewayConversation(request(), followup, "chat", "client"))
        .resolution.resumed,
    ).toBe(false);
  });
  test("normalizes Responses string input and instructions", () => {
    expect(
      conversationMessages("responses", {
        instructions: "  system  ",
        input: "hello",
      }),
    ).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "hello" },
    ]);
  });
});
