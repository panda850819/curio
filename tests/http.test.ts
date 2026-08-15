import { describe, expect, test } from "bun:test";
import { handleRequest } from "../src/http.ts";

describe("HTTP handler", () => {
  test("returns a minimal health response", async () => {
    const response = handleRequest(new Request("http://curio.test/health"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: "ok", service: "curio" });
    expect(body).not.toHaveProperty("databasePath");
  });

  test("returns JSON 404 for unknown paths", async () => {
    const response = handleRequest(new Request("http://curio.test/missing"));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });
});
