import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDatabase } from "./database";
import { PostgresUsageStore } from "./postgres";
import { PostgresAuthStore } from "./pg-auth";
import { PostgresCredentialPool } from "./pg-router";
import { sharedRedisFixture } from "./test-helpers/shared-redis";
import { importLegacy } from "./import-legacy";
import { LocalAuthStore } from "./test-helpers/legacy-auth";
import { CursorCredentialPool } from "./test-helpers/legacy-router";
import { LocalUsageStore } from "./test-helpers/legacy-usage";

describe("PostgreSQL state and legacy import (embedded PostgreSQL)", () => {
  const engine = new PGlite();
  const db = new Pool();
  const fixture = sharedRedisFixture();
  const redis = fixture.cache;
  const secret = "test-original-encryption-secret";
  let directory: string;
  // PGlite executes real PostgreSQL SQL. Only advisory locking is omitted because this
  // fixture uses one embedded connection; the live integration test covers Redis commands.
  const query = async (sql: string, params?: unknown[]) => {
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
    const result = params
      ? await engine.query(sql, params)
      : (await engine.exec(sql)).at(-1)!;
    return {
      ...result,
      rowCount: /^\s*SELECT/i.test(sql)
        ? result.rows.length
        : (result.affectedRows ?? 0),
    };
  };
  beforeAll(async () => {
    db.query = query as typeof db.query;
    db.connect = (async () => ({
      query,
      release() {},
    })) as unknown as typeof db.connect;
    directory = await mkdtemp(join(tmpdir(), "cursor-pg-test-"));
    await migrateDatabase(db);
    await new PostgresUsageStore(db).ensureSchema();
  }, 30000);
  afterAll(async () => {
    await engine.close();
    await db.end();
    await rm(directory, { recursive: true, force: true });
  });

  test("initial setup is unique, sessions and key revocation work across instances", async () => {
    const a = new PostgresAuthStore(db, redis),
      b = new PostgresAuthStore(db, redis);
    const sessions = await Promise.all([
      a.setup("password-one"),
      b.setup("password-two"),
    ]);
    expect(sessions.filter(Boolean)).toHaveLength(1);
    const winner = sessions[0] ? "password-one" : "password-two";
    const session = (await b.login(winner))!;
    expect(await a.isSessionValid(session)).toBe(true);
    await a.revokeSession(session);
    expect(await b.isSessionValid(session)).toBe(false);
    expect(await b.login("wrong")).toBeNull();
    const key = await a.createClientKey("shared");
    expect(await b.clientKey(key.token)).toBe(true);
    expect((await b.listClientKeys())[0].createdAt).toMatch(/Z$/);
    await b.revokeClientKey(key.info.id);
    expect(await a.clientKey(key.token)).toBe(false);
    await a.setPublicBaseUrl("https://gateway.example");
    expect(await b.publicBaseUrl()).toBe("https://gateway.example");
  });

  test("encrypted credentials, model disables and rotation survive new store instances", async () => {
    const a = new PostgresCredentialPool(db, redis, secret),
      b = new PostgresCredentialPool(db, redis, secret);
    const first = await a.addCredential("cursor-secret-one", "one");
    await a.addCredential("cursor-secret-two", "two");
    const raw = await db.query("SELECT secret FROM gateway_credentials");
    expect(JSON.stringify(raw.rows)).not.toContain("cursor-secret");
    const load = async () => [{ id: "auto" }];
    const selected = (await a.select("auto", "client:conversation-1", load))!;
    expect(await b.select("auto", "client:conversation-1", load)).toEqual(
      selected,
    );
    expect(
      (await b.select("auto", "client:conversation-2", load))!.credential.id,
    ).not.toBe(selected.credential.id);
    await a.disableModel(first, "auto");
    expect((await b.select("auto", "client", load))!.credential.id).not.toBe(
      first.id,
    );
    await a.disableCredential(first.id, "billing");
    await b.addCredential(first.apiKey, "bootstrap", false);
    expect((await b.list()).find((c) => c.id === first.id)?.status).toBe(
      "disabled",
    );
    await expect(
      new PostgresCredentialPool(
        db,
        redis,
        "different-encryption-secret",
      ).list(),
    ).rejects.toThrow();
  });

  test("logs aggregate without a date filter and respect cutoff deletion", async () => {
    const store = new PostgresUsageStore(db);
    await store.add({
      endpoint: "/v1/responses",
      model: "auto",
      status: "completed",
      durationMs: 123,
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 30 },
        output_tokens: 20,
        total_tokens: 120,
      },
    });
    await store.add({
      endpoint: "/v1/messages",
      model: "auto",
      status: "error",
      durationMs: 90,
      error: "failure",
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 20,
        output_tokens: 5,
      },
    });
    const rows = await store.list();
    const response = rows.find((r) => r.endpoint === "/v1/responses")!;
    expect(response.input_tokens).toBe(70);
    expect(response.cache_read_tokens).toBe(30);
    expect(response.created_at).toMatch(/Z$/);
    const stats = await store.stats();
    expect(stats.totalRequests).toBe(2);
    expect(stats.failedRequests).toBe(1);
    expect(stats.totalTokens).toBe(205);
    expect(stats.modelBreakdown).toHaveLength(1);
    expect((await store.stats({ startDate: "2099-01-01" })).totalRequests).toBe(
      0,
    );
    await db.query(
      "UPDATE cursor_usage_logs SET created_at='2020-01-01' WHERE endpoint='/v1/messages'",
    );
    expect(await store.deleteBefore("2021-01-01")).toBe(1);
    expect((await new PostgresUsageStore(db).stats()).totalRequests).toBe(1);
  });

  test("legacy import preserves hashes/ciphertext/log IDs and does not resurrect revoked keys", async () => {
    const authPath = join(directory, "auth.json"),
      routerPath = join(directory, "router.json"),
      usagePath = join(directory, "usage.json");
    const oldAuth = new LocalAuthStore(authPath, "legacy-password");
    const oldKey = oldAuth.createClientKey("legacy");
    const oldRouter = new CursorCredentialPool([], routerPath, secret);
    const c = oldRouter.addCredential("cursor-legacy-key");
    oldRouter.disableCredential(c.id, "legacy-disabled");
    oldRouter.disableModel(c, "auto");
    const oldUsage = new LocalUsageStore(usagePath);
    await oldUsage.add({
      endpoint: "/v1/messages",
      model: "auto",
      status: "completed",
      durationMs: 5,
      usage: { input_tokens: 5 },
    });
    const id = (await oldUsage.list())[0].id;
    await importLegacy(
      db,
      { auth: authPath, router: routerPath, usage: usagePath },
      secret,
    );
    const auth = new PostgresAuthStore(db, redis);
    expect(await auth.clientKey(oldKey.token)).toBe(true);
    expect(
      (await new PostgresCredentialPool(db, redis, secret).list())
        .find((r) => r.id === c.id)
        ?.disabledModels.has("auto"),
    ).toBe(true);
    expect(
      (await new PostgresUsageStore(db).list()).some((r) => r.id === id),
    ).toBe(true);
    await auth.revokeClientKey(oldKey.info.id);
    await importLegacy(
      db,
      { auth: authPath, router: routerPath, usage: usagePath },
      secret,
    );
    expect(await auth.clientKey(oldKey.token)).toBe(false);
  });

  test("invalid imports roll back all selected files", async () => {
    const authPath = join(directory, "rollback-auth.json"),
      badPath = join(directory, "bad.json");
    const auth = new LocalAuthStore(authPath);
    const key = auth.createClientKey("rollback");
    await writeFile(
      badPath,
      JSON.stringify({ logs: [{ id: "bad", status: "not-valid" }] }),
    );
    await expect(
      importLegacy(db, { auth: authPath, usage: badPath }, secret),
    ).rejects.toThrow();
    expect(await new PostgresAuthStore(db, redis).clientKey(key.token)).toBe(
      false,
    );
  });

  test("logs preserve request start separately from completion time", async () => {
    const store = new PostgresUsageStore(db);
    const startedAt = Date.parse("2020-06-01T23:59:59.000Z");
    await store.add({
      endpoint: "/v1/responses",
      model: "time-test",
      status: "completed",
      durationMs: 1200,
      startedAt,
    });
    const rows = await store.list({
      startDate: "2020-06-01T00:00:00Z",
      endDate: "2020-06-01T23:59:59.999Z",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].created_at).toBe(new Date(startedAt).toISOString());
    expect(Date.parse(rows[0].completed_at)).toBeGreaterThan(startedAt);
  });
});
