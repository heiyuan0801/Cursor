import { describe, expect, test } from "vitest";
import { errorResponse, parseJsonBody, HttpError } from "./http";
import { sessionToken } from "../sidecar/auth";
describe("HTTP input/error handling", () => {
  test.each(["{", "null", "[]", '"text"'])(
    "rejects malformed or non-object JSON: %s",
    async (body) => {
      await expect(
        parseJsonBody(
          new Request("http://localhost", {
            method: "POST",
            body,
            headers: { "content-type": "application/json" },
          }),
        ),
      ).rejects.toMatchObject({ status: 400 });
    },
  );
  test("does not expose database or Redis connection details", async () => {
    const response = errorResponse(new Error("secret@internal-database:5432"));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("internal-database");
    expect(errorResponse(new HttpError("bad date", 400)).status).toBe(400);
  });
  test("ignores malformed cookie encoding", () => {
    expect(
      sessionToken(
        new Request("http://localhost", {
          headers: { cookie: "cursor2api_session=%not-encoded" },
        }),
      ),
    ).toBe("");
  });
});
