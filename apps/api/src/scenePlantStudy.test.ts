import { describe, expect, it } from "vitest";
import type { PlantLiteModel } from "@bim-studio/contracts";
import { plantLiteRequestFromRecord, runPlantLiteStudy } from "./plantLiteStudy.js";

function model(): PlantLiteModel {
  return {
    id: "scene-logistics:scene", name: "对象物流",
    nodes: [{ id: "source", name: "源", kind: "source", interarrivalTime: { kind: "deterministic", value: 1 } }, { id: "queue", name: "队列", kind: "queue-buffer", capacity: 10 }, { id: "station", name: "工位", kind: "station", capacity: 1, processingTime: { kind: "deterministic", value: 2 } }, { id: "sink", name: "汇", kind: "sink" }],
    edges: [{ id: "a", from: "source", to: "queue" }, { id: "b", from: "queue", to: "station" }, { id: "c", from: "station", to: "sink" }],
    sceneBinding: { sceneId: "scene", nodes: ["source", "queue", "station", "sink"].map((nodeId, index) => ({ nodeId, objectId: `object-${index}`, position: [index * 3, 0, 0] })) },
  };
}
describe("scene-bound Plant Lite studies", () => {
  it("runs the real DES, preserves anchors in the existing Study and reproduces exact trace, statistics and fingerprints", () => {
    const input = model(); const before = structuredClone(input);
    const result = runPlantLiteStudy("project", { name: "场景物流", model: input, seed: "bound", replications: 3, limits: { durationMinutes: 60, maxEvents: 100000, maxResources: 100 } }, "2026-09-05T00:00:00Z");
    expect(result.model?.sceneBinding).toEqual(input.sceneBinding);
    expect(result.outcome.status).toBe("completed"); expect(result.outcome.throughputPerHour.mean).toBeGreaterThan(0);
    expect(result.trace?.events.some(event => event.type === "item-complete" && event.nodeId === "sink")).toBe(true);
    const replay = runPlantLiteStudy("project", plantLiteRequestFromRecord(result), "2026-09-05T00:01:00Z");
    expect(replay.inputFingerprint).toBe(result.inputFingerprint); expect(replay.trace).toEqual(result.trace); expect(replay.outcome).toEqual(result.outcome); expect(input).toEqual(before);
    input.sceneBinding!.nodes[0]!.position[0] = 99;
    expect(runPlantLiteStudy("project", { ...plantLiteRequestFromRecord(result), model: input }, "2026-09-05T00:02:00Z").inputFingerprint).not.toBe(result.inputFingerprint);
  });
  it("rejects invalid or partial anchor snapshots before executing a study", () => {
    const input = model(); input.sceneBinding!.nodes[0]!.position[0] = Infinity;
    expect(() => runPlantLiteStudy("project", { name: "invalid", model: input })).toThrow("场景绑定");
  });
});
