import { HttpError } from "../core/http";

function timestamp(raw: string, field: string, endOfDay = false): string {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const full =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      raw,
    );
  const calendar = new Date(raw.slice(0, 10) + "T00:00:00.000Z");
  if (
    (!dateOnly && !full) ||
    !Number.isFinite(calendar.getTime()) ||
    calendar.toISOString().slice(0, 10) !== raw.slice(0, 10)
  ) {
    throw new HttpError(
      field + " must be a valid ISO date or timestamp",
      400,
      "invalid_request_error",
      field,
    );
  }
  const value = new Date(
    dateOnly ? raw + (endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z") : raw,
  );
  if (!Number.isFinite(value.getTime()))
    throw new HttpError(
      "Invalid " + field,
      400,
      "invalid_request_error",
      field,
    );
  return value.toISOString();
}

export function usageRange(request: Request): {
  startDate?: string;
  endDate?: string;
} {
  const params = new URL(request.url).searchParams;
  const start = params.get("start_date"),
    end = params.get("end_date");
  const startDate = start ? timestamp(start, "start_date") : undefined;
  const endDate = end ? timestamp(end, "end_date", true) : undefined;
  if (startDate && endDate && startDate > endDate)
    throw new HttpError("start_date must not exceed end_date", 400);
  return { startDate, endDate };
}

export function usagePagination(params: URLSearchParams): {
  limit: number;
  offset: number;
} {
  const integer = (
    name: string,
    fallback: number,
    min: number,
    max: number,
  ): number => {
    const raw = params.get(name);
    if (raw === null) return fallback;
    const value = Number(raw);
    if (
      !/^\d+$/.test(raw) ||
      !Number.isSafeInteger(value) ||
      value < min ||
      value > max
    ) {
      throw new HttpError(
        "Invalid " + name,
        400,
        "invalid_request_error",
        name,
      );
    }
    return value;
  };
  return {
    limit: integer("limit", 100, 1, 1000),
    offset: integer("offset", 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

export function usageCutoff(params: URLSearchParams, now = Date.now()): string {
  const raw = params.get("before");
  if (!raw)
    throw new HttpError("Select a cutoff before deleting usage logs", 400);
  const before = timestamp(raw, "before");
  if (Date.parse(before) > now)
    throw new HttpError("Deletion cutoff cannot be in the future", 400);
  return before;
}
