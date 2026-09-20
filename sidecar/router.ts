export interface PoolCatalogModel {
  id: string;
  aliases?: string[];
}

export interface PoolCredential {
  id: string;
  label: string;
  apiKey: string;
  hint: string;
  disabledModels: Set<string>;
  status: "active" | "disabled";
  disabledReason?: string;
  managed: boolean;
}

export function parseCursorCredentialEnv(
  primary = "",
  multiple = "",
): Array<{ apiKey: string; label?: string }> {
  const parsed: Array<{ apiKey: string; label?: string }> = [];
  const trimmed = multiple.trim();
  if (trimmed.startsWith("[")) {
    try {
      const values = JSON.parse(trimmed) as unknown;
      if (Array.isArray(values)) {
        for (const value of values) {
          if (typeof value === "string") parsed.push({ apiKey: value });
          else if (value && typeof value === "object") {
            const item = value as {
              key?: unknown;
              apiKey?: unknown;
              label?: unknown;
            };
            const apiKey =
              typeof item.apiKey === "string"
                ? item.apiKey
                : typeof item.key === "string"
                  ? item.key
                  : "";
            if (apiKey)
              parsed.push({
                apiKey,
                label: typeof item.label === "string" ? item.label : undefined,
              });
          }
        }
      }
    } catch {
      // Fall back to the delimiter format below.
    }
  }
  if (!parsed.length && trimmed) {
    for (const entry of trimmed.split(/[\r\n,;]+/)) {
      const value = entry.trim();
      if (!value) continue;
      const separator = value.indexOf("=");
      parsed.push(
        separator > 0
          ? {
              label: value.slice(0, separator).trim(),
              apiKey: value.slice(separator + 1).trim(),
            }
          : { apiKey: value },
      );
    }
  }
  if (primary.trim())
    parsed.unshift({ apiKey: primary.trim(), label: "default" });
  return parsed;
}

export function canonicalModelId(value: string): string {
  const base =
    value
      .trim()
      .replace(/\[.*\]$/, "")
      .split("/")
      .filter(Boolean)
      .at(-1) || "auto";
  const normalized = base.toLowerCase();
  if (normalized === "default") return "auto";
  if (
    normalized === "composer-2-5" ||
    normalized === "composer-2.5-sdk" ||
    normalized === "composer-latest"
  )
    return "composer-2.5";
  if (normalized === "composer-2-5-fast") return "composer-2.5-fast";
  return normalized;
}

export function isBillingError(error: unknown): boolean {
  const status = numericFields(error, ["status", "statusCode", "httpStatus"]);
  if (status.includes(402)) return true;
  const text = errorText(error).toLowerCase();
  if (
    [
      "rate limit",
      "too many requests",
      "temporarily unavailable",
      "timeout",
      "timed out",
    ].some((marker) => text.includes(marker))
  )
    return false;
  return [
    "billing",
    "payment required",
    "payment_required",
    "insufficient credit",
    "insufficient_credit",
    "insufficient balance",
    "insufficient_balance",
    "spending limit",
    "spending_limit",
    "usage limit",
    "usage_limit",
    "quota exceeded",
    "quota_exceeded",
    "out of credits",
    "out_of_credits",
    "credit exhausted",
    "credit_exhausted",
    "plan limit",
    "plan_limit",
    "subscription required",
    "subscription_required",
  ].some((marker) => text.includes(marker));
}

function errorText(error: unknown, depth = 0): string {
  if (depth > 5 || error === null || error === undefined) return "";
  if (
    typeof error === "string" ||
    typeof error === "number" ||
    typeof error === "boolean"
  )
    return String(error);
  if (error instanceof Error) return `${error.name} ${error.message}`;
  if (Array.isArray(error))
    return error.map((item) => errorText(item, depth + 1)).join(" ");
  if (typeof error === "object")
    return Object.entries(error as Record<string, unknown>)
      .map(([key, value]) => `${key} ${errorText(value, depth + 1)}`)
      .join(" ");
  return "";
}

function numericFields(error: unknown, names: string[], depth = 0): number[] {
  if (depth > 5 || error === null || typeof error !== "object") return [];
  if (Array.isArray(error))
    return error.flatMap((item) => numericFields(item, names, depth + 1));
  const record = error as Record<string, unknown>;
  const values = names.flatMap((name) => {
    const value = record[name];
    if (typeof value === "number") return [value];
    if (typeof value === "string" && /^\d+$/.test(value))
      return [Number(value)];
    return [];
  });
  return [
    ...values,
    ...Object.values(record).flatMap((value) =>
      numericFields(value, names, depth + 1),
    ),
  ];
}
