/**
 * Local usage ledger for the sidecar.
 *
 * The control console reads `/api/usage` and `/api/logs` from this store, so every
 * chat/responses/messages request has to open a record here and close it with the
 * token usage reported by Cursor. Requests served without real usage (the direct
 * `worker/cursor.ts` path never returns any) fall back to a character estimate and
 * are flagged with `estimated` so the console can say so.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { calculateCost, estimateCostFromChars } from "../worker/pricing";
import type { CursorTokenUsage } from "../worker/types";

export type UsageStatus = "running" | "completed" | "error";

export interface UsageLogEntry {
  id: string;
  createdAt: string;
  completedAt: string | null;
  endpoint: string;
  model: string;
  status: UsageStatus;
  stream: boolean;
  promptChars: number;
  completionChars: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  /** True when token counts come from the character estimate instead of Cursor usage. */
  estimated: boolean;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  totalCost: number;
  durationMs: number | null;
  /** Time to first token, in milliseconds. */
  firstTokenMs: number | null;
  /** Output tokens per second over the whole request. */
  tokensPerSecond: number | null;
  cacheHitRate: number;
  error: string | null;
}

export interface UsageStatistics {
  totalRequests: number;
  completedRequests: number;
  failedRequests: number;
  runningRequests: number;
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
  averageTokensPerSecond: number | null;
  averageCacheHitRate: number;
  estimatedRequests: number;
  modelBreakdown: Array<{
    model: string;
    requests: number;
    totalCost: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    averageDurationMs: number | null;
    averageFirstTokenMs: number | null;
    averageTokensPerSecond: number | null;
    cacheHitRate: number;
  }>;
}

export interface UsageQuery {
  startDate?: string;
  endDate?: string;
  model?: string;
  status?: string;
  endpoint?: string;
}

export interface UsageFinishInput {
  status: UsageStatus;
  completionChars?: number;
  usage?: CursorTokenUsage;
  firstTokenMs?: number;
  error?: unknown;
}

/** Handle for one in-flight request. Callers must always close it exactly once. */
export interface UsageRecord {
  readonly id: string;
  /** Stamp the time to first token; later calls are ignored. */
  markFirstToken(): void;
  finish(input: UsageFinishInput): void;
}

interface UsageState {
  version: 1;
  entries: UsageLogEntry[];
}

const DEFAULT_LIMIT = 1000;
const PERSIST_DEBOUNCE_MS = 750;

export class UsageStore {
  private readonly statePath: string;
  private readonly limit: number;
  /** Newest first, so `/api/logs` can slice without sorting. */
  private entries: UsageLogEntry[];
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(statePath = "", limit = DEFAULT_LIMIT) {
    this.statePath = statePath.trim();
    this.limit = Math.max(1, limit);
    this.entries = this.statePath ? readState(this.statePath, this.limit) : [];
  }

  start(input: { endpoint: string; model: string; promptChars: number; stream: boolean }): UsageRecord {
    const startedAt = Date.now();
    const entry: UsageLogEntry = {
      id: `req_${randomId()}`,
      createdAt: new Date(startedAt).toISOString(),
      completedAt: null,
      endpoint: input.endpoint,
      model: input.model || "unknown",
      status: "running",
      stream: input.stream,
      promptChars: input.promptChars,
      completionChars: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      estimated: false,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      totalCost: 0,
      durationMs: null,
      firstTokenMs: null,
      tokensPerSecond: null,
      cacheHitRate: 0,
      error: null
    };

    this.entries.unshift(entry);
    if (this.entries.length > this.limit) this.entries.length = this.limit;

    let firstTokenAt: number | undefined;
    let closed = false;

    return {
      id: entry.id,
      markFirstToken: () => {
        if (firstTokenAt === undefined) firstTokenAt = Date.now();
      },
      finish: (result) => {
        if (closed) return;
        closed = true;
        const finishedAt = Date.now();
        const durationMs = finishedAt - startedAt;
        const completionChars = result.completionChars ?? 0;
        const usage = result.usage ?? estimateUsage(entry.promptChars, completionChars);
        const costs = result.usage
          ? calculateCost(entry.model, result.usage)
          : estimateCostFromChars(entry.model, entry.promptChars, completionChars);
        const firstToken = result.firstTokenMs ?? (firstTokenAt === undefined ? undefined : firstTokenAt - startedAt);

        entry.status = result.status;
        entry.completedAt = new Date(finishedAt).toISOString();
        entry.completionChars = completionChars;
        entry.estimated = !result.usage;
        entry.inputTokens = usage.inputTokens;
        entry.outputTokens = usage.outputTokens;
        entry.cacheReadTokens = usage.cacheReadTokens;
        entry.cacheWriteTokens = usage.cacheWriteTokens;
        entry.reasoningTokens = usage.reasoningTokens ?? 0;
        entry.totalTokens = usage.totalTokens;
        entry.inputCost = costs.inputCost;
        entry.outputCost = costs.outputCost;
        entry.cacheReadCost = costs.cacheReadCost;
        entry.cacheWriteCost = costs.cacheWriteCost;
        entry.totalCost = costs.totalCost;
        entry.durationMs = durationMs;
        entry.firstTokenMs = firstToken === undefined ? null : Math.max(0, Math.round(firstToken));
        entry.tokensPerSecond = durationMs > 0 && usage.outputTokens > 0
          ? usage.outputTokens / (durationMs / 1000)
          : null;
        entry.cacheHitRate = cacheHitRate(usage);
        entry.error = result.error === undefined || result.error === null
          ? null
          : (result.error instanceof Error ? result.error.message : String(result.error)).slice(0, 500);

        this.schedulePersist();
      }
    };
  }

  list(options: UsageQuery & { limit?: number; offset?: number } = {}): UsageLogEntry[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), this.limit);
    const offset = Math.max(options.offset ?? 0, 0);
    return this.entries.filter((entry) => matches(entry, options)).slice(offset, offset + limit);
  }

  statistics(options: UsageQuery = {}): UsageStatistics {
    const entries = this.entries.filter((entry) => matches(entry, options));
    const stats: UsageStatistics = {
      totalRequests: entries.length,
      completedRequests: 0,
      failedRequests: 0,
      runningRequests: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalCost: 0,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      averageDurationMs: null,
      averageFirstTokenMs: null,
      averageTokensPerSecond: null,
      averageCacheHitRate: 0,
      estimatedRequests: 0,
      modelBreakdown: []
    };

    const durations: number[] = [];
    const firstTokens: number[] = [];
    const cacheRates: number[] = [];
    let outputTokensWithDuration = 0;
    let durationMsWithOutput = 0;
    const byModel = new Map<string, UsageLogEntry[]>();

    for (const entry of entries) {
      if (entry.status === "completed") stats.completedRequests += 1;
      else if (entry.status === "error") stats.failedRequests += 1;
      else stats.runningRequests += 1;
      if (entry.estimated) stats.estimatedRequests += 1;

      stats.totalTokens += entry.totalTokens;
      stats.inputTokens += entry.inputTokens;
      stats.outputTokens += entry.outputTokens;
      stats.cacheReadTokens += entry.cacheReadTokens;
      stats.cacheWriteTokens += entry.cacheWriteTokens;
      stats.totalCost += entry.totalCost;
      stats.inputCost += entry.inputCost;
      stats.outputCost += entry.outputCost;
      stats.cacheReadCost += entry.cacheReadCost;
      stats.cacheWriteCost += entry.cacheWriteCost;

      if (entry.durationMs !== null) durations.push(entry.durationMs);
      if (entry.firstTokenMs !== null) firstTokens.push(entry.firstTokenMs);
      if (entry.status === "completed") cacheRates.push(entry.cacheHitRate);
      if (entry.durationMs !== null && entry.outputTokens > 0) {
        outputTokensWithDuration += entry.outputTokens;
        durationMsWithOutput += entry.durationMs;
      }

      const bucket = byModel.get(entry.model);
      if (bucket) bucket.push(entry);
      else byModel.set(entry.model, [entry]);
    }

    stats.averageDurationMs = average(durations);
    stats.averageFirstTokenMs = average(firstTokens);
    stats.averageCacheHitRate = average(cacheRates) ?? 0;
    stats.averageTokensPerSecond = durationMsWithOutput > 0
      ? outputTokensWithDuration / (durationMsWithOutput / 1000)
      : null;

    stats.modelBreakdown = [...byModel.entries()]
      .map(([model, items]) => {
        const modelDurations = items.filter((item) => item.durationMs !== null).map((item) => item.durationMs as number);
        const modelFirstTokens = items.filter((item) => item.firstTokenMs !== null).map((item) => item.firstTokenMs as number);
        const timed = items.filter((item) => item.durationMs !== null && item.outputTokens > 0);
        const timedOutput = timed.reduce((sum, item) => sum + item.outputTokens, 0);
        const timedMs = timed.reduce((sum, item) => sum + (item.durationMs as number), 0);
        const inputTokens = items.reduce((sum, item) => sum + item.inputTokens, 0);
        const cacheReadTokens = items.reduce((sum, item) => sum + item.cacheReadTokens, 0);
        const cacheWriteTokens = items.reduce((sum, item) => sum + item.cacheWriteTokens, 0);
        const cacheDenominator = inputTokens + cacheReadTokens + cacheWriteTokens;
        return {
          model,
          requests: items.length,
          totalCost: items.reduce((sum, item) => sum + item.totalCost, 0),
          totalTokens: items.reduce((sum, item) => sum + item.totalTokens, 0),
          inputTokens,
          outputTokens: items.reduce((sum, item) => sum + item.outputTokens, 0),
          cacheReadTokens,
          averageDurationMs: average(modelDurations),
          averageFirstTokenMs: average(modelFirstTokens),
          averageTokensPerSecond: timedMs > 0 ? timedOutput / (timedMs / 1000) : null,
          cacheHitRate: cacheDenominator > 0 ? cacheReadTokens / cacheDenominator : 0
        };
      })
      .sort((a, b) => b.requests - a.requests);

    return stats;
  }

  clear(): void {
    this.entries = [];
    this.schedulePersist();
  }

  private schedulePersist(): void {
    if (!this.statePath || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persist();
    }, PERSIST_DEBOUNCE_MS);
    this.persistTimer.unref?.();
  }

  private persist(): void {
    if (!this.statePath) return;
    const state: UsageState = { version: 1, entries: this.entries.slice(0, this.limit) };
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      writeFileSync(this.statePath, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      console.warn(`Could not persist usage log: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** Cursor reports `inputTokens` exclusive of cached tokens, so the hit rate is
 * cache reads over everything that was fed into the prompt. */
export function cacheHitRate(usage: CursorTokenUsage): number {
  const promptTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  return promptTokens > 0 ? usage.cacheReadTokens / promptTokens : 0;
}

function estimateUsage(promptChars: number, completionChars: number): CursorTokenUsage {
  const inputTokens = Math.ceil(promptChars / 4);
  const outputTokens = Math.ceil(completionChars / 4);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: inputTokens + outputTokens
  };
}

function matches(entry: UsageLogEntry, options: UsageQuery): boolean {
  if (options.startDate && entry.createdAt < options.startDate) return false;
  if (options.endDate && entry.createdAt > options.endDate) return false;
  if (options.model && entry.model !== options.model) return false;
  if (options.status && entry.status !== options.status) return false;
  if (options.endpoint && entry.endpoint !== options.endpoint) return false;
  return true;
}

function average(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function randomId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 24);
}

function readState(path: string, limit: number): UsageLogEntry[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<UsageState>;
    if (!Array.isArray(parsed.entries)) return [];
    return parsed.entries
      .filter((entry): entry is UsageLogEntry => Boolean(entry && typeof entry.id === "string" && typeof entry.createdAt === "string"))
      // A request still marked "running" was cut short by a restart; it can never complete.
      .map((entry) => (entry.status === "running" ? { ...entry, status: "error" as const, error: entry.error || "Server restarted before the request finished" } : entry))
      .slice(0, limit);
  } catch {
    return [];
  }
}
