import { calculateCost } from "../core/pricing";
import type { CursorTokenUsage } from "../core/types";

export interface LocalUsageLog {
  id: string;
  endpoint: string;
  model: string | null;
  status: "completed" | "error";
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
  duration_ms: number;
  created_at: string;
  completed_at: string;
  error: string | null;
}

export interface LocalUsageStats {
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

export interface UsageLogInput {
  endpoint: string;
  model?: string | null;
  status: "completed" | "error";
  usage?: Record<string, unknown> | null;
  durationMs: number;
  startedAt?: number;
  error?: string | null;
}

export interface UsageStore {
  add(input: UsageLogInput): Promise<void>;
  list(options?: {
    startDate?: string;
    endDate?: string;
    limit?: number;
    offset?: number;
  }): Promise<LocalUsageLog[]>;
  stats(options?: {
    startDate?: string;
    endDate?: string;
  }): Promise<LocalUsageStats>;
  deleteBefore(before: string): Promise<number>;
}

export function normalizeUsage(
  model: string,
  usage: Record<string, unknown> | null | undefined,
) {
  const record = usage || {};
  const details = (record.prompt_tokens_details ||
    record.input_tokens_details ||
    {}) as Record<string, unknown>;
  const hasDetails = Boolean(
    record.prompt_tokens_details || record.input_tokens_details,
  );
  const inputTokens = Math.max(
    0,
    number(record.prompt_tokens ?? record.input_tokens) -
      (hasDetails
        ? number(details.cached_tokens) + number(details.cache_creation_tokens)
        : 0),
  );
  const outputTokens = number(record.output_tokens ?? record.completion_tokens);
  const cacheReadTokens = number(
    details.cached_tokens ?? record.cache_read_input_tokens,
  );
  const cacheWriteTokens = number(
    details.cache_creation_tokens ?? record.cache_creation_input_tokens,
  );
  const cursorUsage: CursorTokenUsage = {
    inputTokens: Math.max(0, inputTokens),
    outputTokens: Math.max(0, outputTokens),
    cacheReadTokens: Math.max(0, cacheReadTokens),
    cacheWriteTokens: Math.max(0, cacheWriteTokens),
    totalTokens:
      number(record.total_tokens) ||
      inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
  };
  const costs =
    typeof record.cost === "number"
      ? {
          inputCost: 0,
          outputCost: 0,
          cacheReadCost: 0,
          cacheWriteCost: 0,
          totalCost: record.cost,
        }
      : calculateCost(model, cursorUsage);
  return {
    total_tokens: cursorUsage.totalTokens,
    input_tokens: cursorUsage.inputTokens,
    output_tokens: cursorUsage.outputTokens,
    cache_read_tokens: cursorUsage.cacheReadTokens,
    cache_write_tokens: cursorUsage.cacheWriteTokens,
    input_cost: costs.inputCost,
    output_cost: costs.outputCost,
    cache_read_cost: costs.cacheReadCost,
    cache_write_cost: costs.cacheWriteCost,
    total_cost: costs.totalCost,
  };
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
