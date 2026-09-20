import { createDatabase, migrateDatabase } from "./database";
import { PostgresUsageStore } from "./postgres";
import { importLegacy } from "./import-legacy";
import { PostgresCredentialPool } from "./pg-router";
import { RedisJsonCache } from "./redis-cache";
import { parseCursorCredentialEnv } from "./router";

const db = createDatabase();
try {
  await migrateDatabase(db);
  await new PostgresUsageStore(db).ensureSchema();
  if (process.argv.includes("--import")) {
    const paths: { auth?: string; router?: string; usage?: string } = {};
    for (const kind of ["auth", "router", "usage"] as const) {
      const i = process.argv.indexOf("--" + kind);
      if (i >= 0) {
        if (!process.argv[i + 1] || process.argv[i + 1].startsWith("--"))
          throw new Error("Missing file for --" + kind);
        paths[kind] = process.argv[i + 1];
      }
    }
    const redis = new RedisJsonCache(
      process.env.REDIS_URL || "redis://127.0.0.1:6379",
    );
    const pool = new PostgresCredentialPool(
      db,
      redis,
      process.env.ENCRYPTION_KEY || "",
    );
    for (const c of parseCursorCredentialEnv(
      process.env.CURSOR_API_KEY,
      process.env.CURSOR_API_KEYS,
    ))
      await pool.addCredential(c.apiKey, c.label, false);
    await importLegacy(db, paths, process.env.ENCRYPTION_KEY || "");
    await redis.close();
  }
  console.log("Database migration completed; source files preserved.");
} finally {
  await db.end();
}
