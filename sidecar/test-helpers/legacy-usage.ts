import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { calculateCost } from "../../core/pricing";
import type { CursorTokenUsage } from "../../core/types";

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
  modelBreakdown: Array<{ model: string; requests: number; totalCost: number; totalTokens: number }>;
}

interface PersistedState { version: 1; logs: LocalUsageLog[]; }

export interface UsageLogInput {
  endpoint: string;
  model?: string | null;
  status: "completed" | "error";
  usage?: Record<string, unknown> | null;
  durationMs: number;
  error?: string | null;
}

export interface UsageStore {
  add(input: UsageLogInput): Promise<void>;
  list(options?: { startDate?: string; endDate?: string; limit?: number; offset?: number }): Promise<LocalUsageLog[]>;
  stats(options?: { startDate?: string; endDate?: string }): Promise<LocalUsageStats>;
  deleteBefore(before: string): Promise<number>;
}

export class LocalUsageStore implements UsageStore {
  private readonly path: string;
  private state: PersistedState;

  constructor(path: string) {
    this.path = path;
    this.state = readState(path);
  }

  async add(input: UsageLogInput): Promise<void> {
    const usage = normalizeUsage(input.model || "", input.usage);
    const now = new Date().toISOString();
    this.state.logs.push({
      id: `local_req_${crypto.randomUUID()}`,
      endpoint: input.endpoint,
      model: input.model || null,
      status: input.status,
      ...usage,
      duration_ms: Math.max(0, Math.round(input.durationMs)),
      created_at: now,
      completed_at: now,
      error: input.error || null
    });
    if (this.state.logs.length > 10000) this.state.logs.splice(0, this.state.logs.length - 10000);
    this.persist();
  }

  async list(options: { startDate?: string; endDate?: string; limit?: number; offset?: number } = {}): Promise<LocalUsageLog[]> {
    const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 10000);
    const offset = Math.max(Number(options.offset) || 0, 0);
    return this.state.logs
      .filter((log) => (!options.startDate || log.created_at >= options.startDate) && (!options.endDate || log.created_at <= options.endDate))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(offset, offset + limit);
  }

  async stats(options: { startDate?: string; endDate?: string } = {}): Promise<LocalUsageStats> {
    const logs = await this.list({ ...options, limit: 10000 });
    const completed = logs.filter((log) => log.status === "completed");
    const sum = (key: keyof LocalUsageLog): number => logs.reduce((total, log) => total + Number(log[key] || 0), 0);
    const byModel = new Map<string, { requests: number; totalCost: number; totalTokens: number }>();
    for (const log of logs) {
      if (!log.model) continue;
      const item = byModel.get(log.model) || { requests: 0, totalCost: 0, totalTokens: 0 };
      item.requests += 1; item.totalCost += log.total_cost; item.totalTokens += log.total_tokens;
      byModel.set(log.model, item);
    }
    return {
      totalRequests: logs.length,
      completedRequests: completed.length,
      failedRequests: logs.length - completed.length,
      totalTokens: sum("total_tokens"), inputTokens: sum("input_tokens"), outputTokens: sum("output_tokens"),
      cacheReadTokens: sum("cache_read_tokens"), cacheWriteTokens: sum("cache_write_tokens"),
      totalCost: sum("total_cost"), inputCost: sum("input_cost"), outputCost: sum("output_cost"),
      cacheReadCost: sum("cache_read_cost"), cacheWriteCost: sum("cache_write_cost"),
      averageDurationMs: logs.length ? sum("duration_ms") / logs.length : null,
      averageFirstTokenMs: null,
      averageCacheHitRate: sum("input_tokens") + sum("cache_read_tokens") + sum("cache_write_tokens") > 0
        ? sum("cache_read_tokens") / (sum("input_tokens") + sum("cache_read_tokens") + sum("cache_write_tokens")) : 0,
      modelBreakdown: [...byModel.entries()].sort((a, b) => b[1].totalCost - a[1].totalCost).map(([model, value]) => ({ model, ...value }))
    };
  }

  async deleteBefore(before: string): Promise<number> {
    const original = this.state.logs.length;
    this.state.logs = this.state.logs.filter((log) => log.created_at >= before);
    const deleted = original - this.state.logs.length;
    if (deleted) this.persist();
    return deleted;
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.state, null, 2), { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      console.warn(`Could not persist local usage state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function normalizeUsage(model: string, usage: Record<string, unknown> | null | undefined) {
  const record = usage || {};
  const details = (record.prompt_tokens_details || record.input_tokens_details || {}) as Record<string, unknown>;
  const hasDetails = Boolean(record.prompt_tokens_details || record.input_tokens_details);
  const inputTokens = Math.max(0, number(record.prompt_tokens ?? record.input_tokens) - (hasDetails ? number(details.cached_tokens) + number(details.cache_creation_tokens) : 0));
  const outputTokens = number(record.output_tokens ?? record.completion_tokens);
  const cacheReadTokens = number(details.cached_tokens ?? record.cache_read_input_tokens);
  const cacheWriteTokens = number(details.cache_creation_tokens ?? record.cache_creation_input_tokens);
  const cursorUsage: CursorTokenUsage = {
    inputTokens: Math.max(0, inputTokens), outputTokens: Math.max(0, outputTokens),
    cacheReadTokens: Math.max(0, cacheReadTokens), cacheWriteTokens: Math.max(0, cacheWriteTokens),
    totalTokens: number(record.total_tokens) || inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
  };
  const costs = typeof record.cost === "number" ? { inputCost: 0, outputCost: 0, cacheReadCost: 0, cacheWriteCost: 0, totalCost: record.cost } : calculateCost(model, cursorUsage);
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
    total_cost: costs.totalCost
  };
}

function number(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }

function readState(path: string): PersistedState {
  if (!existsSync(path)) return { version: 1, logs: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PersistedState>;
    return { version: 1, logs: Array.isArray(parsed.logs) ? parsed.logs.filter((log): log is LocalUsageLog => Boolean(log && typeof log.id === "string" && typeof log.created_at === "string")) : [] };
  } catch { return { version: 1, logs: [] }; }
}
