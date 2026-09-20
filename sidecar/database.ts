import { Pool, type PoolConfig } from "pg";

export function createDatabase(env: NodeJS.ProcessEnv = process.env): Pool {
  const connectionString = (env.DATABASE_URL || env.POSTGRES_URL || "").trim();
  if (!connectionString && !env.PGHOST)
    throw new Error("DATABASE_URL or PGHOST is required");
  const config: PoolConfig = connectionString
    ? { connectionString }
    : {
        host: env.PGHOST,
        port: Number(env.PGPORT || 5432),
        database: env.PGDATABASE,
        user: env.PGUSER,
        password: env.PGPASSWORD,
      };
  const pool = new Pool({
    ...config,
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 15000,
  });
  pool.on("error", () =>
    console.error("PostgreSQL background connection failed"),
  );
  return pool;
}

export async function migrateDatabase(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(67180919)");
    await client.query(`
      CREATE TABLE IF NOT EXISTS gateway_settings (key TEXT PRIMARY KEY, value JSONB NOT NULL);
      CREATE TABLE IF NOT EXISTS gateway_client_keys (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, hint TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS gateway_credentials (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, hint TEXT NOT NULL, secret JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')), disabled_reason TEXT
      );
      CREATE TABLE IF NOT EXISTS gateway_disabled_models (
        credential_id TEXT NOT NULL REFERENCES gateway_credentials(id) ON DELETE CASCADE,
        model TEXT NOT NULL, PRIMARY KEY(credential_id, model)
      );
      CREATE TABLE IF NOT EXISTS gateway_imports (source TEXT PRIMARY KEY, imported_at TIMESTAMPTZ NOT NULL DEFAULT now());
    `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
