import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Pool } from "pg";
import { PostgresCredentialPool } from "./pg-router";
import type { PoolCredential } from "./router";
import { sharedRedisFixture } from "./test-helpers/shared-redis";

describe("conversation-sticky account selection", () => {
  let fixture: ReturnType<typeof sharedRedisFixture>;
  let a: PostgresCredentialPool, b: PostgresCredentialPool;
  let credentials: PoolCredential[];
  const load = async () => [{ id: "auto" }, { id: "composer-2.5" }];
  beforeEach(() => {
    fixture = sharedRedisFixture();
    credentials = ["one", "two", "three"].map((id) => ({
      id,
      apiKey: id,
      label: id,
      hint: id,
      disabledModels: new Set<string>(),
      status: "active",
      managed: true,
    }));
    a = new PostgresCredentialPool(
      {} as Pool,
      fixture.cache,
      "test-encryption-key",
      60,
    );
    b = new PostgresCredentialPool(
      {} as Pool,
      fixture.cache,
      "test-encryption-key",
      60,
    );
    vi.spyOn(a, "list").mockImplementation(async () => credentials);
    vi.spyOn(b, "list").mockImplementation(async () => credentials);
  });
  test("new conversations rotate globally, follow-ups stay fixed across instances", async () => {
    const first = (await a.select("auto", "client-1:chat-1", load))!;
    expect(
      (await b.select("auto", "client-2:chat-1", load))!.credential.id,
    ).toBe("two");
    expect(
      (await a.select("auto", "client-1:chat-2", load))!.credential.id,
    ).toBe("three");
    for (let i = 0; i < 10; i++)
      expect(await b.select("auto", "client-1:chat-1", load)).toEqual(first);
    expect(
      (await a.select("auto", "client-1:chat-3", load))!.credential.id,
    ).toBe("one");
  });
  test("simultaneous first requests agree on the account and SDK generation", async () => {
    const selected = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 ? a : b).select("auto", "same", load),
      ),
    );
    expect(new Set(selected.map((v) => v!.credential.id)).size).toBe(1);
    expect(new Set(selected.map((v) => v!.sessionKey)).size).toBe(1);
    expect((await a.select("auto", "new", load))!.credential.id).toBe("two");
  });
  test("idle TTL refreshes; expiry creates a fresh SDK generation even with one account", async () => {
    credentials.splice(1);
    const first = (await a.select("auto", "same", load))!;
    fixture.advance(59000);
    expect(await b.select("auto", "same", load)).toEqual(first);
    fixture.advance(59000);
    expect(await a.select("auto", "same", load)).toEqual(first);
    fixture.advance(61000);
    const expired = (await b.select("auto", "same", load))!;
    expect(expired.credential.id).toBe(first.credential.id);
    expect(expired.sessionKey).not.toBe(first.sessionKey);
  });
  test("disabled, unsupported and failed accounts are rebound with a fresh session", async () => {
    const first = (await a.select("auto", "same", load))!;
    credentials[0].disabledModels.add("auto");
    const second = (await b.select("auto", "same", load))!;
    expect(second.credential.id).not.toBe(first.credential.id);
    expect(second.sessionKey).not.toBe(first.sessionKey);
    expect(await a.select("auto", "same", load)).toEqual(second);
    second.credential.status = "disabled";
    const third = (await a.select("auto", "same", load))!;
    expect(third.credential.id).not.toBe(second.credential.id);
    expect(
      await a.select("auto", "same", load, new Set([third.credential.id])),
    ).toBeUndefined();
  });
  test("model catalog changes rebind; discovery failures do not silently move a warm conversation", async () => {
    const first = (await a.select("auto", "same", load))!;
    await expect(
      b.select("auto", "same", async (key) => {
        if (key === first.credential.apiKey) throw new Error("temporary");
        return load();
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(await b.select("auto", "same", load)).toEqual(first);
    const replacement = (await a.select("auto", "same", async (key) =>
      key === first.credential.apiKey ? [] : load(),
    ))!;
    expect(replacement.credential.id).not.toBe(first.credential.id);
  });
  test("model or tool configuration switches keep the account but replace stale SDK agents", async () => {
    const first = (await a.select("auto", "same", load))!;
    const otherModel = (await b.select("composer-2.5", "same", load))!;
    expect(otherModel.credential.id).toBe(first.credential.id);
    expect(otherModel.sessionKey).not.toBe(first.sessionKey);
    const back = (await a.select("auto", "same", load))!;
    expect(back.sessionKey).not.toBe(first.sessionKey);
    const changedTools = (await b.select(
      "auto",
      "same",
      load,
      new Set(),
      "new-tools",
    ))!;
    expect(changedTools.credential.id).toBe(first.credential.id);
    expect(changedTools.sessionKey).not.toBe(back.sessionKey);
    expect(
      await a.select("auto", "same", load, new Set(), "new-tools"),
    ).toEqual(changedTools);
  });
  test("retry session updates are shared and guarded against stale writers", async () => {
    const first = (await a.select("auto", "same", load))!;
    expect(
      await a.replaceSession(
        "same",
        first.credential.id,
        first.sessionKey,
        "retry",
      ),
    ).toBe(true);
    expect((await b.select("auto", "same", load))!.sessionKey).toBe("retry");
    expect(
      await b.replaceSession(
        "same",
        first.credential.id,
        first.sessionKey,
        "stale",
      ),
    ).toBe(false);
    expect(
      await a.replaceSession("same", "wrong-account", "retry", "bad"),
    ).toBe(false);
    expect((await a.select("auto", "same", load))!.sessionKey).toBe("retry");
  });
  test("rejects unsafe TTL values", () => {
    for (const ttl of [0, 59, 86401, 60.5, NaN])
      expect(
        () =>
          new PostgresCredentialPool(
            {} as Pool,
            fixture.cache,
            "test-encryption-key",
            ttl,
          ),
      ).toThrow(/TTL/);
  });
  test("catalog outage is 503 rather than an unsupported-model 404", async () => {
    await expect(
      a.select("auto", "new", async () => {
        throw new Error("offline");
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(await a.select("unknown", "new", load)).toBeUndefined();
  });
});
