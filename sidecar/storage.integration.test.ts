import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Pool } from "pg";
import { RedisJsonCache } from "./redis-cache";
import { migrateDatabase } from "./database";
import { PostgresUsageStore } from "./postgres";
import { PostgresAuthStore } from "./pg-auth";
import { PostgresCredentialPool } from "./pg-router";

// Only explicit test URLs enable network integration. Never use the application's URLs.
describe.skipIf(!process.env.TEST_DATABASE_URL || !process.env.TEST_REDIS_URL)(
  "live PostgreSQL + Redis",
  () => {
    const namespace = "cursor_test_" + crypto.randomUUID().replaceAll("-", "");
    let admin: Pool, db: Pool, a: RedisJsonCache, b: RedisJsonCache;
    beforeAll(async () => {
      admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
      await admin.query("CREATE SCHEMA " + namespace);
      db = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
        options: "-c search_path=" + namespace,
      });
      a = new RedisJsonCache(process.env.TEST_REDIS_URL!, namespace + ":");
      b = new RedisJsonCache(process.env.TEST_REDIS_URL!, namespace + ":");
      await Promise.all([a.connect(), b.connect()]);
      await Promise.all([
        migrateDatabase(db),
        migrateDatabase(db),
        new PostgresUsageStore(db).ensureSchema(),
      ]);
    }, 30000);
    afterAll(async () => {
      if (a) {
        const keys = await a.client.keys(namespace + ":*");
        if (keys.length) await a.client.del(...keys);
        await a.close();
      }
      await b?.close();
      await db?.end();
      if (admin) {
        await admin.query("DROP SCHEMA IF EXISTS " + namespace + " CASCADE");
        await admin.end();
      }
    });
    test("shared sessions survive new instances and revocation is immediate", async () => {
      const first = new PostgresAuthStore(db, a),
        second = new PostgresAuthStore(db, b);
      const tokens = await Promise.all([
        first.setup("password-one"),
        second.setup("password-two"),
      ]);
      expect(tokens.filter(Boolean)).toHaveLength(1);
      const session = tokens.find(Boolean)!;
      expect(await second.isSessionValid(session)).toBe(true);
      await first.revokeSession(session);
      expect(await second.isSessionValid(session)).toBe(false);
      const key = await first.createClientKey();
      expect(await second.clientKey(key.token)).toBe(true);
      await second.revokeClientKey(key.info.id);
      expect(await first.clientKey(key.token)).toBe(false);
    });
    test("GETDEL has only one winner and counters carry TTL", async () => {
      await a.set("claim", { agentId: "shared" }, 60);
      const claims = await Promise.all([a.take("claim"), b.take("claim")]);
      expect(claims.filter(Boolean)).toEqual([{ agentId: "shared" }]);
      expect(
        (
          await Promise.all([
            a.increment("counter", 60),
            b.increment("counter", 60),
          ])
        ).sort(),
      ).toEqual([1, 2]);
      expect(await b.client.ttl(namespace + ":counter")).toBeGreaterThan(0);
      expect(await a.client.ttl(namespace + ":counter")).toBeLessThanOrEqual(
        60,
      );
    });
    test("sticky Lua selection is atomic, refreshes TTL and guards retry generations", async () => {
      const key = "{routing}:integration-binding",
        counter = "{routing}:integration-counter";
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          (i % 2 ? a : b).selectSticky(
            key,
            counter,
            ["one", "two"],
            60,
            "model-a",
          ),
        ),
      );
      expect(new Set(results.map((v) => v!.sessionKey)).size).toBe(1);
      expect(new Set(results.map((v) => v!.credentialId))).toEqual(
        new Set(["one"]),
      );
      expect(await a.client.get(namespace + ":" + counter)).toBe("1");
      await a.client.expire(namespace + ":" + key, 1);
      expect(
        await b.selectSticky(key, counter, ["one", "two"], 60, "model-a"),
      ).toEqual(results[0]);
      expect(await a.client.ttl(namespace + ":" + key)).toBeGreaterThan(50);
      const switched = (await a.selectSticky(
        key,
        counter,
        ["one", "two"],
        60,
        "model-b",
      ))!;
      expect(switched.credentialId).toBe("one");
      expect(switched.sessionKey).not.toBe(results[0]!.sessionKey);
      expect(
        await b.replaceStickySession(
          key,
          "one",
          results[0]!.sessionKey,
          "stale",
          60,
        ),
      ).toBe(false);
      expect(
        await b.replaceStickySession(
          key,
          "one",
          switched.sessionKey,
          "retry",
          60,
        ),
      ).toBe(true);
      expect(
        (await a.selectSticky(key, counter, ["one", "two"], 60, "model-b"))!
          .sessionKey,
      ).toBe("retry");
      const replacement = (await b.selectSticky(
        key,
        counter,
        ["two"],
        60,
        "model-b",
      ))!;
      expect(replacement.credentialId).toBe("two");
      expect(replacement.sessionKey).not.toBe("retry");
      await a.delete(key);
      expect(
        (await b.selectSticky(key, counter, ["two"], 60, "model-b"))!
          .sessionKey,
      ).not.toBe(replacement.sessionKey);
    });
    test("pool bindings survive API instances and PG disablement triggers failover", async () => {
      const first = new PostgresCredentialPool(
          db,
          a,
          "integration-only-secret",
        ),
        second = new PostgresCredentialPool(db, b, "integration-only-secret");
      await first.addCredential("integration-credential-one");
      await first.addCredential("integration-credential-two");
      const load = async () => [{ id: "auto" }];
      const warm = (await first.select(
        "auto",
        "integration-conversation",
        load,
      ))!;
      expect(
        await second.select("auto", "integration-conversation", load),
      ).toEqual(warm);
      await first.disableModel(warm.credential, "auto");
      const rebound = (await second.select(
        "auto",
        "integration-conversation",
        load,
      ))!;
      expect(rebound.credential.id).not.toBe(warm.credential.id);
      expect(rebound.sessionKey).not.toBe(warm.sessionKey);
      expect(
        await first.select("auto", "integration-conversation", load),
      ).toEqual(rebound);
    });
    test("concurrent usage schema initialization and unfiltered stats", async () => {
      const a = new PostgresUsageStore(db),
        b = new PostgresUsageStore(db);
      await Promise.all([
        a.add({
          endpoint: "/v1/messages",
          model: "auto",
          status: "completed",
          durationMs: 10,
        }),
        b.add({
          endpoint: "/v1/messages",
          model: "auto",
          status: "error",
          durationMs: 20,
        }),
      ]);
      expect((await a.stats()).totalRequests).toBe(2);
    });
  },
);
