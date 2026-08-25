import { describe, expect, it } from "vitest";
import { externalCadConverterRegistrations } from "./converterCatalog.js";
import { registerConversionTaskRoutes } from "./conversionTaskRoutes.js";
import { ConversionTaskService } from "./conversionTasks.js";
import { createApiServer } from "./serverOptions.js";

describe("conversion task routes", () => {
  it("submits, queries, lists, and cancels an unavailable JT task without claiming conversion support", async () => {
    const app = createApiServer();
    const service = new ConversionTaskService(await externalCadConverterRegistrations({}), undefined, () => "task-jt");
    await registerConversionTaskRoutes(app, { service, projectExists: (projectId) => projectId === "project-1" });

    const catalog = await app.inject({ method: "GET", url: "/api/converters" });
    const submit = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/conversion-tasks",
      payload: {
        pluginId: "industrial-cad.jt",
        input: { objectKey: "projects/project-1/imports/assembly.jt", fileName: "assembly.jt", format: "jt", size: 4096 }
      }
    });
    const query = await app.inject({ method: "GET", url: "/api/projects/project-1/conversion-tasks/task-jt" });
    const list = await app.inject({ method: "GET", url: "/api/projects/project-1/conversion-tasks" });
    const cancel = await app.inject({ method: "POST", url: "/api/projects/project-1/conversion-tasks/task-jt/cancel" });

    expect(catalog.statusCode).toBe(200);
    expect(catalog.json().find((item: { manifest: { id: string } }) => item.manifest.id === "industrial-cad.jt")).toMatchObject({ available: false });
    expect(catalog.json().find((item: { manifest: { id: string } }) => item.manifest.id === "industrial-cad.parasolid")).toMatchObject({
      available: false,
      provider: { id: "cadexchanger-batch", deployment: "server", status: "not_configured" }
    });
    expect(submit.statusCode).toBe(202);
    expect(submit.json()).toMatchObject({ id: "task-jt", status: "waiting_converter", artifacts: [] });
    expect(query.json().status).toBe("waiting_converter");
    expect(list.json()).toHaveLength(1);
    expect(cancel.json().status).toBe("cancelled");
    await app.close();
  });

  it("rejects unsupported formats and missing projects", async () => {
    const app = createApiServer();
    const service = new ConversionTaskService(await externalCadConverterRegistrations({}));
    await registerConversionTaskRoutes(app, { service, projectExists: () => false });

    const missing = await app.inject({ method: "POST", url: "/api/projects/missing/conversion-tasks", payload: {} });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});
