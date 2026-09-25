import cors from "@fastify/cors";
import { describe, expect, it } from "vitest";
import { API_CORS_METHODS, createApiServer } from "./serverOptions.js";

describe("API CORS contract", () => {
  it("permits the mutation methods used by browser and Tauri editors", async () => {
    const app = createApiServer();
    await app.register(cors, { origin: "http://tauri.localhost", methods: [...API_CORS_METHODS] });
    app.put("/scene", async () => ({ ok: true }));

    const response = await app.inject({
      method: "OPTIONS",
      url: "/scene",
      headers: {
        origin: "http://tauri.localhost",
        "access-control-request-method": "PUT",
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("http://tauri.localhost");
    expect(response.headers["access-control-allow-methods"]).toContain("PUT");
    await app.close();
  });
});
