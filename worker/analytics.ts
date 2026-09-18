import type { Env } from "./types";

export interface RequestLogRow {
  id: string;
  account_id: string;
  endpoint: string;
  model: string | null;
  cursor_agent_id: string | null;
  cursor_run_id: string | null;
  status: string;
  prompt_chars: number;
  completion_chars: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  reasoning_tokens: number;
  input_cost: number;
  output_cost: number;
  cache_read_cost: number;
  cache_write_cost: number;
  total_cost: number;
  duration_ms: number | null;
  first_token_ms: number | null;
  cache_hit_rate: number;
  error: string | null;
  created_at: string;
  completed_at: string | null;
  request_id: string | null;
  conversation_id: string | null;
}

export interface UsageStatistics {
  totalRequests: number;
  completedRequests: number;
  failedRequests: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCost: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  averageDurationMs: number | null;
  averageFirstTokenMs: number | null;
  averageCacheHitRate: number;
  modelBreakdown: Array<{
    model: string;
    requests: number;
    totalCost: number;
    totalTokens: number;
  }>;
}

export async function getRequestLogs(
  env: Env,
  accountId: string,
  options: {
    limit?: number;
    offset?: number;
    startDate?: string;
    endDate?: string;
    model?: string;
    status?: string;
  } = {}
): Promise<RequestLogRow[]> {
  const limit = Math.min(options.limit || 100, 1000);
  const offset = options.offset || 0;

  let query = `SELECT * FROM request_logs WHERE account_id = ?`;
  const bindings: unknown[] = [accountId];

  if (options.startDate) {
    query += ` AND created_at >= ?`;
    bindings.push(options.startDate);
  }

  if (options.endDate) {
    query += ` AND created_at <= ?`;
    bindings.push(options.endDate);
  }

  if (options.model) {
    query += ` AND model = ?`;
    bindings.push(options.model);
  }

  if (options.status) {
    query += ` AND status = ?`;
    bindings.push(options.status);
  }

  query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  bindings.push(limit, offset);

  const statement = env.DB.prepare(query).bind(...bindings) as unknown as {
    all?: <T>() => Promise<{ results?: T[] }>;
  };

  if (typeof statement.all !== "function") return [];
  const result = await statement.all<RequestLogRow>();
  return result.results ?? [];
}

export async function getUsageStatistics(
  env: Env,
  accountId: string,
  options: {
    startDate?: string;
    endDate?: string;
    model?: string;
  } = {}
): Promise<UsageStatistics> {
  let query = `
    SELECT
      COUNT(*) as total_requests,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_requests,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as failed_requests,
      SUM(COALESCE(total_tokens, 0)) as total_tokens,
      SUM(COALESCE(input_tokens, 0)) as input_tokens,
      SUM(COALESCE(output_tokens, 0)) as output_tokens,
      SUM(COALESCE(cache_read_tokens, 0)) as cache_read_tokens,
      SUM(COALESCE(cache_write_tokens, 0)) as cache_write_tokens,
      SUM(COALESCE(total_cost, 0)) as total_cost,
      SUM(COALESCE(input_cost, 0)) as input_cost,
      SUM(COALESCE(output_cost, 0)) as output_cost,
      SUM(COALESCE(cache_read_cost, 0)) as cache_read_cost,
      SUM(COALESCE(cache_write_cost, 0)) as cache_write_cost,
      AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms END) as avg_duration_ms,
      AVG(CASE WHEN first_token_ms IS NOT NULL THEN first_token_ms END) as avg_first_token_ms,
      AVG(COALESCE(cache_hit_rate, 0)) as avg_cache_hit_rate
    FROM request_logs
    WHERE account_id = ?
  `;

  const bindings: unknown[] = [accountId];

  if (options.startDate) {
    query += ` AND created_at >= ?`;
    bindings.push(options.startDate);
  }

  if (options.endDate) {
    query += ` AND created_at <= ?`;
    bindings.push(options.endDate);
  }

  if (options.model) {
    query += ` AND model = ?`;
    bindings.push(options.model);
  }

  const stats = await env.DB.prepare(query)
    .bind(...bindings)
    .first<{
      total_requests: number;
      completed_requests: number;
      failed_requests: number;
      total_tokens: number;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      total_cost: number;
      input_cost: number;
      output_cost: number;
      cache_read_cost: number;
      cache_write_cost: number;
      avg_duration_ms: number | null;
      avg_first_token_ms: number | null;
      avg_cache_hit_rate: number;
    }>();

  // Get model breakdown
  let modelQuery = `
    SELECT
      model,
      COUNT(*) as requests,
      SUM(COALESCE(total_cost, 0)) as total_cost,
      SUM(COALESCE(total_tokens, 0)) as total_tokens
    FROM request_logs
    WHERE account_id = ? AND model IS NOT NULL
  `;

  const modelBindings: unknown[] = [accountId];

  if (options.startDate) {
    modelQuery += ` AND created_at >= ?`;
    modelBindings.push(options.startDate);
  }

  if (options.endDate) {
    modelQuery += ` AND created_at <= ?`;
    modelBindings.push(options.endDate);
  }

  modelQuery += ` GROUP BY model ORDER BY total_cost DESC`;

  const modelStatement = env.DB.prepare(modelQuery).bind(...modelBindings) as unknown as {
    all?: <T>() => Promise<{ results?: T[] }>;
  };

  const modelResult =
    typeof modelStatement.all === "function"
      ? await modelStatement.all<{
          model: string;
          requests: number;
          total_cost: number;
          total_tokens: number;
        }>()
      : { results: [] };

  return {
    totalRequests: stats?.total_requests || 0,
    completedRequests: stats?.completed_requests || 0,
    failedRequests: stats?.failed_requests || 0,
    totalTokens: stats?.total_tokens || 0,
    inputTokens: stats?.input_tokens || 0,
    outputTokens: stats?.output_tokens || 0,
    cacheReadTokens: stats?.cache_read_tokens || 0,
    cacheWriteTokens: stats?.cache_write_tokens || 0,
    totalCost: stats?.total_cost || 0,
    inputCost: stats?.input_cost || 0,
    outputCost: stats?.output_cost || 0,
    cacheReadCost: stats?.cache_read_cost || 0,
    cacheWriteCost: stats?.cache_write_cost || 0,
    averageDurationMs: stats?.avg_duration_ms || null,
    averageFirstTokenMs: stats?.avg_first_token_ms || null,
    averageCacheHitRate: stats?.avg_cache_hit_rate || 0,
    modelBreakdown: modelResult.results ?? []
  };
}
