import { describe, expect, it } from "vitest";
import { runAgentTaskDag } from "./taskDag.js";

describe("agent task DAG", () => {
  it("runs scene authoring, capture and validation in dependency order", async () => {
    const order: string[] = [];
    const result = await runAgentTaskDag([
      { id: "scene", kind: "tool", run: async () => { order.push("scene"); return { output: { revision: 1 } }; } },
      { id: "capture", kind: "capture", dependsOn: ["scene"], run: async ({ outputs }) => { order.push("capture"); return { output: { scene: outputs.get("scene") }, evidence: [{ id: "shot", kind: "screenshot", label: "场景截图", source: "test", fingerprint: "sha256:shot" }] }; } },
      { id: "validate", kind: "validate", dependsOn: ["capture"], run: async () => { order.push("validate"); return { passed: true }; } },
    ]);
    expect(result.status).toBe("completed");
    expect(order).toEqual(["scene", "capture", "validate"]);
    expect(result.evidence[0]?.fingerprint).toBe("sha256:shot");
  });

  it("bounds failed visual correction and rejects cycles", async () => {
    const result = await runAgentTaskDag([
      { id: "validate", kind: "validate", dependsOn: ["correct"], run: async () => ({ passed: false }) },
      { id: "correct", kind: "correct", dependsOn: ["validate"], run: async () => ({}) },
    ]);
    expect(result).toMatchObject({ status: "failed", error: { code: "cycle" } });
  });

  it("re-runs validation after one bounded correction", async () => {
    let checks = 0;
    const result = await runAgentTaskDag([
      { id: "scene", kind: "tool", run: async () => ({ output: { revision: 1 } }) },
      { id: "validate", kind: "validate", dependsOn: ["scene"], run: async () => ({ passed: ++checks > 1 }) },
      { id: "correct", kind: "correct", dependsOn: ["validate"], run: async () => ({ output: { corrected: true } }) },
    ], { maxCorrections: 1 });
    expect(result.status).toBe("completed");
    expect(checks).toBe(2);
  });

  it("cancels before executing a ready task", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runAgentTaskDag([{ id: "scene", kind: "tool", run: async () => ({}) }], { signal: controller.signal });
    expect(result).toMatchObject({ status: "cancelled", error: { code: "cancelled" } });
  });
});
