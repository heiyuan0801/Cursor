import { describe, expect, test } from "vitest";
import { usageRange, usageCutoff, usagePagination } from "./usage-query";
const request = (params: Record<string, string>) =>
  new Request("http://localhost/api/usage?" + new URLSearchParams(params));
describe("usage query validation", () => {
  test("empty filters remain valid and date-only end includes the whole UTC day", () => {
    expect(usageRange(request({}))).toEqual({
      startDate: undefined,
      endDate: undefined,
    });
    expect(
      usageRange(request({ start_date: "2026-09-19", end_date: "2026-09-19" })),
    ).toEqual({
      startDate: "2026-09-19T00:00:00.000Z",
      endDate: "2026-09-19T23:59:59.999Z",
    });
  });
  test("honors explicit timezone offsets", () => {
    expect(
      usageRange(request({ start_date: "2026-09-19T00:00:00+08:00" }))
        .startDate,
    ).toBe("2026-09-18T16:00:00.000Z");
  });
  test.each(["garbage", "2026-02-30", "2026-13-01", "2026-09-19T00:00:00"])(
    "rejects invalid dates: %s",
    (start_date) => {
      expect(() => usageRange(request({ start_date }))).toThrow();
    },
  );
  test("rejects reversed ranges and unbounded or future cleanup", () => {
    expect(() =>
      usageRange(request({ start_date: "2026-09-20", end_date: "2026-09-19" })),
    ).toThrow();
    expect(() => usageCutoff(new URLSearchParams())).toThrow();
    expect(() =>
      usageCutoff(new URLSearchParams({ before: "2099-01-01" })),
    ).toThrow();
    expect(usageCutoff(new URLSearchParams({ before: "2020-01-01" }))).toBe(
      "2020-01-01T00:00:00.000Z",
    );
  });
  test("pagination rejects fractional, negative and excessive values", () => {
    expect(usagePagination(new URLSearchParams())).toEqual({
      limit: 100,
      offset: 0,
    });
    for (const values of [
      { limit: "-1" },
      { limit: "1.5" },
      { limit: "1001" },
      { offset: "-1" },
    ]) {
      expect(() => usagePagination(new URLSearchParams(values))).toThrow();
    }
  });
});
