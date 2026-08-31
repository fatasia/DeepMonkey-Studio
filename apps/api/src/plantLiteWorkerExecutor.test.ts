import { describe, expect, it } from "vitest";
import {
  PlantLiteWorkerCancelledError,
  PlantLiteWorkerExecutionError,
  PlantLiteWorkerExecutor,
  PlantLiteWorkerTimeoutError,
} from "./plantLiteWorkerExecutor.js";

describe("PlantLiteWorkerExecutor", () => {
  it("rejects a request already cancelled before a Worker is started", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(new PlantLiteWorkerExecutor().run("project-1", { name: "cancelled" }, controller.signal)).rejects.toBeInstanceOf(PlantLiteWorkerCancelledError);
  });

  it("surfaces Worker validation failures without persisting a fake study", async () => {
    await expect(new PlantLiteWorkerExecutor().run("project-1", { name: "invalid", agvCount: 0 })).rejects.toBeInstanceOf(PlantLiteWorkerExecutionError);
  });

  it("terminates a Worker that does not complete inside the bounded execution window", async () => {
    const executor = new PlantLiteWorkerExecutor({ timeoutMs: 1 });
    await expect(executor.run("project-1", { name: "timeout", replications: 30 })).rejects.toBeInstanceOf(PlantLiteWorkerTimeoutError);
  });
});
