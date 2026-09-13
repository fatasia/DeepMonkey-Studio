import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import multipart from "@fastify/multipart";
import { expect, it, vi } from "vitest";
import { createApiServer } from "./serverOptions.js";
import { OperationsService } from "./operations.js";
import { createIndustrialCapabilityHost, registerIndustrialCapabilityRoutes } from "./industrialCapabilities.js";
import type { BatteryModelGateway } from "./batteryModelGateway.js";

it("cancels inference when a client disconnects after uploading its complete body", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "battery-http-abort-"));
  const app = createApiServer();
  let received: AbortSignal | undefined;
  const gateway = { async predict(_input, signal) {
    received = signal;
    await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }));
    signal?.throwIfAborted();
    return {};
  } } as BatteryModelGateway;
  const controller = new AbortController();
  try {
    const operations = new OperationsService(directory); await operations.init();
    const host = await createIndustrialCapabilityHost(operations, { batteryGateway: gateway });
    await app.register(multipart);
    await registerIndustrialCapabilityRoutes(app, { host, store: { getProject: () => ({ id: "qa" }) } as never });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const form = new FormData(); form.append("model", "bmsformer");
    form.append("file", new Blob(["cycle,time,voltage,current,capacityAh\n1,0,3.4,-1,100\n"]), "qa.csv");
    const request = fetch(`${address}/api/projects/qa/battery/predictions`, { method: "POST", body: form, signal: controller.signal }).catch(error => error);
    await vi.waitFor(() => expect(received).toBeDefined());
    controller.abort();
    await vi.waitFor(() => expect(received?.aborted).toBe(true));
    await request;
  } finally { controller.abort(); await app.close(); await rm(directory, { recursive: true, force: true }); }
});
