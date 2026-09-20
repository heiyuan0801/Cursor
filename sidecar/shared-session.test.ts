import { afterEach, describe, expect, test, vi } from "vitest";
import {
  configureChatSessionStore,
  rememberChatSession,
  resolveChatSession,
} from "../core/chat-session";
import { createCursorSdkCompletion } from "../core/cursor-sdk";
import type { Env, Deps } from "../core/types";

describe("shared conversation and SDK sessions", () => {
  test("SDK refuses to start without an injected shared store", async () => {
    await expect(
      createCursorSdkCompletion(
        {} as Env,
        {
          now: () => new Date(),
          randomUUID: () => crypto.randomUUID(),
          fetch: vi.fn(),
        },
        "key",
        { prompt: { text: "hello" } },
      ),
    ).rejects.toMatchObject({ status: 503 });
  });
  afterEach(() => configureChatSessionStore());
  test("conversation claims are shared, single-use and isolated by owner", async () => {
    const entries = new Map<
      string,
      { sessionKey: string; updatedAt: number }
    >();
    configureChatSessionStore({
      async take(key) {
        const value = entries.get(key);
        entries.delete(key);
        return value;
      },
      async set(key, value) {
        entries.set(key, value);
      },
    });
    const messages = [{ role: "user", content: "hello" }];
    await rememberChatSession({
      messages,
      ownerKey: "client-a",
      sessionKey: "warm",
      assistantText: "hi",
      now: Date.now(),
    });
    const next = [
      ...messages,
      { role: "assistant", content: "hi" },
      { role: "user", content: "next" },
    ];
    expect(
      (
        await resolveChatSession(next, "client-b", Date.now(), () =>
          crypto.randomUUID(),
        )
      ).resumed,
    ).toBe(false);
    const attempts = await Promise.all(
      [1, 2].map(() =>
        resolveChatSession(next, "client-a", Date.now(), () =>
          crypto.randomUUID(),
        ),
      ),
    );
    expect(attempts.filter((v) => v.resumed)).toHaveLength(1);
    expect(attempts.find((v) => v.resumed)?.sessionKey).toBe("warm");
  });
  test("SDK uses only the configured shared store and honors cache eviction", async () => {
    const entries = new Map<string, { agentId: string; updatedAt: number }>();
    const set = vi.fn(
      async (
        key: string,
        value: { agentId: string; updatedAt: number },
        _ttl: number,
      ) => {
        entries.set(key, value);
      },
    );
    const env = {
      CURSOR_SDK_BRIDGE_URL: "http://bridge.test/sdk",
      SDK_SESSION_STORE: {
        async get(key: string) {
          return entries.get(key);
        },
        set,
        async delete(key: string) {
          entries.delete(key);
        },
      },
    } as unknown as Env;
    const deps = {
      now: () => new Date(),
      randomUUID: () => crypto.randomUUID(),
      fetch: vi.fn(),
    } as Deps;
    const input = {
      prompt: { text: "test" },
      sessionKey: "shared",
      sessionOwnerKey: "client-a",
    };
    const first = await createCursorSdkCompletion(
      env,
      deps,
      "cursor-key",
      input,
    );
    const second = await createCursorSdkCompletion(
      { ...env },
      deps,
      "cursor-key",
      input,
    );
    expect(second.agentId).toBe(first.agentId);
    expect(set.mock.calls[0][2]).toBe(21600);
    entries.clear();
    const third = await createCursorSdkCompletion(
      env,
      deps,
      "cursor-key",
      input,
    );
    expect(third.agentId).not.toBe(first.agentId);
  });
  test("shared store outages fail closed instead of falling back to process state", async () => {
    const env = {
      CURSOR_SDK_BRIDGE_URL: "http://bridge.test/sdk",
      SDK_SESSION_STORE: {
        async get() {
          throw new Error("Redis unavailable");
        },
      },
    } as unknown as Env;
    const deps = {
      now: () => new Date(),
      randomUUID: () => crypto.randomUUID(),
      fetch: vi.fn(),
    } as Deps;
    await expect(
      createCursorSdkCompletion(env, deps, "cursor-key", {
        prompt: { text: "test" },
        sessionKey: "shared",
      }),
    ).rejects.toThrow("Redis unavailable");
  });
});
