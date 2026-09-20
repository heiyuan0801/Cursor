import { Pool, type PoolConfig } from "pg";
import { normalizeUsage } from "./usage";
import type {
  LocalUsageLog,
  LocalUsageStats,
  UsageLogInput,
  UsageStore,
} from "./usage";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cursor_usage_logs (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('completed', 'error')),
  total_tokens BIGINT NOT NULL DEFAULT 0,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens BIGINT NOT NULL DEFAULT 0,
  cache_write_tokens BIGINT NOT NULL DEFAULT 0,
  total_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  input_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  output_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  cache_read_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  cache_write_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_cursor_usage_logs_created_at ON cursor_usage_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cursor_usage_logs_model_created_at ON cursor_usage_logs (model, created_at DESC);
`;

export class PostgresUsageStore implements UsageStore {
  private readonly pool: Pool;
  private schemaPromise: Promise<void> | undefined;

  constructor(config: string | PoolConfig | Pool) {
    this.pool =
      config instanceof Pool
        ? config
        : new Pool(
            typeof config === "string" ? { connectionString: config } : config,
          );
  }

  async add(input: UsageLogInput): Promise<void> {
    await this.ensureSchema();
    const usage = normalizeUsage(input.model || "", input.usage);
    const now = new Date();
    await this.pool.query(
      `INSERT INTO cursor_usage_logs (
        id, endpoint, model, status, total_tokens, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, total_cost, input_cost, output_cost,
        cache_read_cost, cache_write_cost, duration_ms, created_at, completed_at, error
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [
        `local_req_${crypto.randomUUID()}`,
        input.endpoint,
        input.model || null,
        input.status,
        usage.total_tokens,
        usage.input_tokens,
        usage.output_tokens,
        usage.cache_read_tokens,
        usage.cache_write_tokens,
        usage.total_cost,
        usage.input_cost,
        usage.output_cost,
        usage.cache_read_cost,
        usage.cache_write_cost,
        Math.max(0, Math.round(input.durationMs)),
        new Date(input.startedAt ?? now.getTime()),
        now,
        input.error || null,
      ],
    );
  }

  async list(
    options: {
      startDate?: string;
      endDate?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<LocalUsageLog[]> {
    await this.ensureSchema();
    const { where, values } = buildDateFilter(
      options.startDate,
      options.endDate,
    );
    const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 10000);
    const offset = Math.max(Number(options.offset) || 0, 0);
    values.push(limit, offset);
    const result = await this.pool.query<LocalUsageLog>(
      `SELECT id, endpoint, model, status, total_tokens, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, total_cost, input_cost, output_cost,
        cache_read_cost, cache_write_cost, duration_ms, created_at, completed_at, error
       FROM cursor_usage_logs ${where} ORDER BY created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return result.rows.map(normalizeRow);
  }

  async stats(
    options: { startDate?: string; endDate?: string } = {},
  ): Promise<LocalUsageStats> {
    await this.ensureSchema();
    const filter = buildDateFilter(options.startDate, options.endDate);
    const summary = await this.pool.query<Record<string, unknown>>(
      `SELECT COUNT(*)::int AS total_requests,
        COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_requests,
        COUNT(*) FILTER (WHERE status = 'error')::int AS failed_requests,
        COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
        COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
        COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
        COALESCE(SUM(cache_read_tokens), 0)::bigint AS cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0)::bigint AS cache_write_tokens,
        COALESCE(SUM(total_cost), 0)::double precision AS total_cost,
        COALESCE(SUM(input_cost), 0)::double precision AS input_cost,
        COALESCE(SUM(output_cost), 0)::double precision AS output_cost,
        COALESCE(SUM(cache_read_cost), 0)::double precision AS cache_read_cost,
        COALESCE(SUM(cache_write_cost), 0)::double precision AS cache_write_cost,
        AVG(duration_ms)::double precision AS average_duration_ms
       FROM cursor_usage_logs ${filter.where}`,
      filter.values,
    );
    const models = await this.pool.query<{
      model: string;
      requests: number;
      total_cost: number;
      total_tokens: number;
    }>(
      `SELECT model, COUNT(*)::int AS requests,
        COALESCE(SUM(total_cost), 0)::double precision AS total_cost,
        COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens
       FROM cursor_usage_logs ${filter.where} AND model IS NOT NULL
       GROUP BY model ORDER BY total_cost DESC`,
      filter.values,
    );
    const row = summary.rows[0] || {};
    return {
      totalRequests: number(row.total_requests),
      completedRequests: number(row.completed_requests),
      failedRequests: number(row.failed_requests),
      totalTokens: number(row.total_tokens),
      inputTokens: number(row.input_tokens),
      outputTokens: number(row.output_tokens),
      cacheReadTokens: number(row.cache_read_tokens),
      cacheWriteTokens: number(row.cache_write_tokens),
      totalCost: number(row.total_cost),
      inputCost: number(row.input_cost),
      outputCost: number(row.output_cost),
      cacheReadCost: number(row.cache_read_cost),
      cacheWriteCost: number(row.cache_write_cost),
      averageDurationMs:
        row.average_duration_ms == null
          ? null
          : number(row.average_duration_ms),
      averageFirstTokenMs: null,
      averageCacheHitRate: cacheRate(row),
      modelBreakdown: models.rows.map((model) => ({
        model: model.model,
        requests: number(model.requests),
        totalCost: number(model.total_cost),
        totalTokens: number(model.total_tokens),
      })),
    };
  }

  async deleteBefore(before: string): Promise<number> {
    await this.ensureSchema();
    const result = await this.pool.query(
      "DELETE FROM cursor_usage_logs WHERE created_at < $1",
      [before],
    );
    return result.rowCount || 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async ensureSchema(): Promise<void> {
    this.schemaPromise ||= this.initializeSchema().catch((error) => {
      this.schemaPromise = undefined;
      throw error;
    });
    await this.schemaPromise;
  }

  private async initializeSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(67180919)");
      await client.query(SCHEMA);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function buildDateFilter(
  startDate?: string,
  endDate?: string,
): { where: string; values: Array<string | number> } {
  const values: Array<string | number> = [];
  const clauses: string[] = [];
  if (startDate) {
    values.push(startDate);
    clauses.push(`created_at >= $${values.length}`);
  }
  if (endDate) {
    values.push(endDate);
    clauses.push(`created_at <= $${values.length}`);
  }
  return {
    where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "WHERE TRUE",
    values,
  };
}

function normalizeRow(row: LocalUsageLog): LocalUsageLog {
  return {
    ...row,
    created_at: new Date(row.created_at).toISOString(),
    completed_at: new Date(row.completed_at).toISOString(),
    total_tokens: number(row.total_tokens),
    input_tokens: number(row.input_tokens),
    output_tokens: number(row.output_tokens),
    cache_read_tokens: number(row.cache_read_tokens),
    cache_write_tokens: number(row.cache_write_tokens),
    total_cost: number(row.total_cost),
    input_cost: number(row.input_cost),
    output_cost: number(row.output_cost),
    cache_read_cost: number(row.cache_read_cost),
    cache_write_cost: number(row.cache_write_cost),
    duration_ms: number(row.duration_ms),
  };
}

function cacheRate(row: Record<string, unknown>): number {
  const input =
    number(row.input_tokens) +
    number(row.cache_read_tokens) +
    number(row.cache_write_tokens);
  return input ? number(row.cache_read_tokens) / input : 0;
}

function number(value: unknown): number {
  const result = typeof value === "number" ? value : Number(value);
  return Number.isFinite(result) ? result : 0;
}
