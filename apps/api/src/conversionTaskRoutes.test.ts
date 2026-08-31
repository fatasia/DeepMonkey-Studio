import { describe, expect, it } from "vitest";
import { registerConversionTaskRoutes } from "./conversionTaskRoutes.js";
import { ConversionTaskService } from "./conversionTasks.js";
import { createApiServer } from "./serverOptions.js";

describe("conversion task routes", () => {
  it("returns the configured catalog and rejects unknown plugins", async () => {
    const app = createApiServer();
    const service = new ConversionTaskService([]);
    await registerConversionTaskRoutes(app, { service, projectExists: (projectId) => projectId === "project-1" });

    const catalog = await app.inject({ method: "GET", url: "/api/converters" });
    const submit = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/conversion-tasks",
      payload: {
        pluginId: "removed.external-cad",
        input: { objectKey: "projects/project-1/imports/assembly.cad", fileName: "assembly.cad", format: "cad", size: 4096 }
      }
    });
    const list = await app.inject({ method: "GET", url: "/api/projects/project-1/conversion-tasks" });

    expect(catalog.statusCode).toBe(200);
    expect(catalog.json()).toEqual([]);
    expect(submit.statusCode).toBe(404);
    expect(list.json()).toHaveLength(0);
    await app.close();
  });

  it("rejects unsupported formats and missing projects", async () => {
    const app = createApiServer();
    const service = new ConversionTaskService([]);
    await registerConversionTaskRoutes(app, { service, projectExists: () => false });

    const missing = await app.inject({ method: "POST", url: "/api/projects/missing/conversion-tasks", payload: {} });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});
