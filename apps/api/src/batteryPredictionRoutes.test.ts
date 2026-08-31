import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import multipart from "@fastify/multipart";
import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "./serverOptions.js";
import { OperationsService } from "./operations.js";
import { createIndustrialCapabilityHost, registerIndustrialCapabilityRoutes } from "./industrialCapabilities.js";
import type { BatteryModelGateway, BatteryPredictionInput } from "./batteryModelGateway.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe("battery prediction upload route", () => {
  it("parses multipart CSV and executes the shared battery capability", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-battery-upload-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const operations = new OperationsService(directory);
    await operations.init();
    const calls: BatteryPredictionInput[] = [];
    const host = await createIndustrialCapabilityHost(operations, { batteryGateway: gateway(calls) });
    const app = createApiServer();
    cleanups.push(() => app.close());
    await app.register(multipart);
    await registerIndustrialCapabilityRoutes(app, {
      host,
      store: { getProject: (id: string) => id === "project-1" ? { id } : undefined } as never,
    });

    const form = new FormData();
    form.append("model", "bmsformer");
    form.append("chemistry", "lfp");
    form.append("nominalCapacityAh", "100");
    form.append("file", new Blob(["cellId,cycle,voltage\nLFP-01,1,3.28\n"], { type: "text/csv" }), "cell.csv");
    const encoded = new Response(form);
    const response = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/battery/predictions",
      headers: { "content-type": encoded.headers.get("content-type")! },
      payload: Buffer.from(await encoded.arrayBuffer()),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "completed", output: { currentSoh: 98.5 } });
    expect(calls).toEqual([expect.objectContaining({
      model: "bmsformer",
      chemistry: "lfp",
      nominalCapacityAh: 100,
      fileName: "cell.csv",
      records: [{ cellId: "LFP-01", cycle: 1, voltage: 3.28 }],
    })]);
  });
});

function gateway(calls: BatteryPredictionInput[]): BatteryModelGateway {
  return {
    predict: async (input) => {
      calls.push(input);
      return { currentSoh: 98.5, confidence: "high" };
    },
    health: async () => ({}),
    digitalTwinStatus: async () => ({}),
    releaseStatus: async () => ({}),
    initializeTwin: async () => ({}),
    simulateTwin: async () => ({}),
    assimilateTwin: async () => ({}),
    twinEvidence: async () => ({}),
  };
}
