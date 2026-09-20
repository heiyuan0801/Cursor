import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { configureChatSessionStore } from "../core/chat-session";
import { digest } from "./pg-auth";
import { resolveGatewayConversation } from "./conversation";
import { expandPreviousResponse } from "./response-context";
import { sharedRedisFixture } from "./test-helpers/shared-redis";

describe("Responses continuation routing", () => {
  let fixture: ReturnType<typeof sharedRedisFixture>;
  const req = () => new Request("http://gateway.test/v1/responses");
  beforeEach(() => {
    fixture = sharedRedisFixture();
    configureChatSessionStore(fixture.cache);
  });
  afterEach(() => configureChatSessionStore());
  const seed = async () => {
    const first = await resolveGatewayConversation(
      req(),
      { input: "hello" },
      "responses",
      "client",
    );
    await first.remember("hi", []);
    await fixture.cache.set(
      "response:" + digest("client") + ":resp_1",
      {
        response: {
          id: "resp_1",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "hi" }],
            },
          ],
        },
        conversationId: first.id,
        inputItems: [{ role: "user", content: "hello" }],
      },
      86400,
    );
    return first;
  };
  test("previous_response_id restores input and output, continues the warm session and forks safely", async () => {
    const first = await seed();
    const body = await expandPreviousResponse(
      fixture.cache,
      "client",
      { previous_response_id: "resp_1", input: "next" },
      10000,
    );
    expect(body.input).toHaveLength(3);
    const next = await resolveGatewayConversation(
      req(),
      body,
      "responses",
      "client",
    );
    expect(next.id).toBe(first.id);
    expect(
      (await resolveGatewayConversation(req(), body, "responses", "client")).id,
    ).not.toBe(first.id);
  });
  test("context cannot be fetched with another client key, after deletion, or after expiry", async () => {
    await seed();
    const body = { previous_response_id: "resp_1", input: "next" };
    await expect(
      expandPreviousResponse(fixture.cache, "other", body, 10000),
    ).rejects.toMatchObject({ status: 404 });
    fixture.advance(86401000);
    await expect(
      expandPreviousResponse(fixture.cache, "client", body, 10000),
    ).rejects.toMatchObject({ status: 404 });
    await seed();
    await fixture.cache.delete("response:" + digest("client") + ":resp_1");
    await expect(
      expandPreviousResponse(fixture.cache, "client", body, 10000),
    ).rejects.toMatchObject({ status: 404 });
  });
  test("rejects invalid identifiers, oversized context and pre-upgrade output-only entries", async () => {
    await seed();
    for (const id of ["", " ", 1])
      await expect(
        expandPreviousResponse(
          fixture.cache,
          "client",
          { previous_response_id: id },
          10000,
        ),
      ).rejects.toMatchObject({ status: 400 });
    await expect(
      expandPreviousResponse(
        fixture.cache,
        "client",
        { previous_response_id: "resp_1", input: "next" },
        10,
      ),
    ).rejects.toMatchObject({ status: 413 });
    await fixture.cache.set(
      "response:" + digest("client") + ":old",
      { id: "old", output: [] },
      60,
    );
    await expect(
      expandPreviousResponse(
        fixture.cache,
        "client",
        { previous_response_id: "old" },
        10000,
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await expandPreviousResponse(
        fixture.cache,
        "client",
        { input: "hello" },
        10000,
      ),
    ).toEqual({ input: "hello" });
  });
});
