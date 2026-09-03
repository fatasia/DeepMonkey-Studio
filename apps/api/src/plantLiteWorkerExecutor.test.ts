import { describe, expect, it } from "vitest";
import {
  PlantLiteWorkerCancelledError,
  PlantLiteWorkerExecutionError,
  PlantLiteWorkerExecutor,
  PlantLiteWorkerTimeoutError,
  decodeWorkerMessage,
  isNodeWatchControlMessage,
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

  it("rejects malformed Worker messages instead of resolving an undefined study", () => {
    expect(decodeWorkerMessage({ type: "result" })).toEqual({
      ok: false,
      message: "Plant Lite Worker 协议无效（type=result；字段：type）",
    });
    expect(decodeWorkerMessage(undefined)).toEqual({
      ok: false,
      message: "Plant Lite Worker 协议无效（收到 undefined）",
    });
  });

  it("recognizes only Node watch dependency notifications as ignorable control messages", () => {
    expect(isNodeWatchControlMessage({ "watch:import": ["file:///plantLiteWorker.ts"] })).toBe(true);
    expect(isNodeWatchControlMessage({ "watch:require": "plant-lite" })).toBe(true);
    expect(isNodeWatchControlMessage({ "watch:import": [], type: "result" })).toBe(false);
    expect(isNodeWatchControlMessage({ type: "result" })).toBe(false);
  });
});
