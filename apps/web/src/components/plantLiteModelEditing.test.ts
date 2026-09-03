import { describe, expect, it } from "vitest";
import { validatePlantLiteModel } from "@bim-studio/plant-lite-simulation";
import {
  addPlantLiteNode,
  bindPlantLiteStationWorkerPool,
  changeDistributionKind,
  createPlantLiteStationWorkerPool,
  createDefaultPlantLiteRequest,
  movePlantLiteNode,
  plantLiteModelIssues,
  removePlantLiteNode,
  reorderPlantLiteNode,
  resetPlantLiteModel,
  setPlantLiteStationEquipment,
  setPlantLiteStationWorker,
  setDistributionTypicalValue,
} from "./plantLiteModelEditing";

describe("Plant Lite model authoring", () => {
  it("starts from the shared solver template and stays valid after adding every process node kind", () => {
    const request = createDefaultPlantLiteRequest();
    let model = request.model!;
    model = addPlantLiteNode(model, "station");
    model = addPlantLiteNode(model, "queue-buffer");
    model = addPlantLiteNode(model, "transport");

    expect(model.nodes.map((node) => node.kind)).toEqual([
      "source", "station", "queue-buffer", "transport", "station", "station", "queue-buffer", "transport", "sink",
    ]);
    expect(model.edges).toHaveLength(model.nodes.length - 1);
    expect(validatePlantLiteModel(model)).toMatchObject({ valid: true });
    expect(plantLiteModelIssues({ ...request, model })).toEqual([]);
  });

  it("reorders and deletes process nodes while rebuilding explicit sequence edges", () => {
    const model = createDefaultPlantLiteRequest().model!;
    const moved = movePlantLiteNode(model, "transport", -1);
    expect(moved.nodes.map((node) => node.id)).toEqual(["source", "station-a", "transport", "queue-buffer", "station-b", "sink"]);
    expect(moved.edges).toContainEqual({ id: "station-a--transport", from: "station-a", to: "transport" });

    const dragged = reorderPlantLiteNode(moved, "station-b", "transport");
    expect(dragged.nodes.map((node) => node.id)).toEqual(["source", "station-a", "station-b", "transport", "queue-buffer", "sink"]);
    const draggedDown = reorderPlantLiteNode(model, "station-a", "queue-buffer");
    expect(draggedDown.nodes.map((node) => node.id)).toEqual(["source", "queue-buffer", "station-a", "transport", "station-b", "sink"]);
    const removed = removePlantLiteNode(dragged, "queue-buffer");
    expect(removed.nodes.some((node) => node.id === "queue-buffer")).toBe(false);
    expect(validatePlantLiteModel(removed)).toMatchObject({ valid: true });

    const movedToEnd = reorderPlantLiteNode(model, "station-a", "sink");
    expect(movedToEnd.nodes.map((node) => node.id)).toEqual(["source", "queue-buffer", "transport", "station-b", "station-a", "sink"]);

    const withoutTransport = removePlantLiteNode(model, "transport");
    expect(withoutTransport.resources).toBeUndefined();
    expect(validatePlantLiteModel(withoutTransport)).toMatchObject({ valid: true });
  });

  it("keeps a typical duration stable when changing the advanced probability distribution", () => {
    const normal = changeDistributionKind({ kind: "deterministic", value: 8 }, "normal");
    expect(normal).toMatchObject({ kind: "normal", mean: 8 });
    expect(setDistributionTypicalValue(normal, 12)).toMatchObject({ kind: "normal", mean: 12 });
  });

  it("surfaces disconnected graph evidence before run", () => {
    const request = createDefaultPlantLiteRequest();
    request.model!.edges = request.model!.edges.filter((edge) => edge.to !== "sink");
    expect(plantLiteModelIssues(request)).toEqual(expect.arrayContaining([expect.stringContaining("非产出端节点必须有出边")]));
  });

  it("validates collapsed run settings before the primary run action", () => {
    const request = createDefaultPlantLiteRequest();
    expect(plantLiteModelIssues({ ...request, seed: "", replications: 0, limits: { durationMinutes: 0 } })).toEqual(expect.arrayContaining([
      expect.stringContaining("随机种子"),
      expect.stringContaining("统计运行次数"),
      expect.stringContaining("总运行时长"),
    ]));
  });

  it("catches authored resource capacity above the protected run limit before submit", () => {
    const request = createDefaultPlantLiteRequest();
    request.model!.resources![0]!.capacity = 8;
    expect(plantLiteModelIssues({ ...request, limits: { maxResources: 4 } })).toContain("设备、搬运与人工资源共 8 个，超过运行上限 4");
  });

  it("adds and removes a cloned equipment resource without breaking transport bindings", () => {
    const baseline = createDefaultPlantLiteRequest().model!;
    const enabled = setPlantLiteStationEquipment(baseline, "station-a", true);
    const station = enabled.nodes.find((node) => node.id === "station-a");
    const equipment = enabled.resources?.find((resource) => resource.kind === "equipment");

    expect(station).toMatchObject({ kind: "station", resourceId: equipment?.id });
    expect(station).not.toHaveProperty("power");
    expect(equipment).toMatchObject({ name: "装配工位设备", capacity: 1, power: { activePowerKw: 18, idlePowerKw: 2.2 } });
    expect(enabled.resources?.find((resource) => resource.id === "agv-fleet")?.kind).toBe("agv");
    expect(baseline.nodes.find((node) => node.id === "station-a")).not.toHaveProperty("resourceId");
    expect(validatePlantLiteModel(enabled)).toMatchObject({ valid: true });

    const withTransport = addPlantLiteNode(enabled, "transport");
    const addedTransport = withTransport.nodes.filter((node) => node.kind === "transport").at(-1);
    expect(addedTransport).toMatchObject({ resourceId: "agv-fleet" });

    const disabled = setPlantLiteStationEquipment(enabled, "station-a", false);
    expect(disabled.nodes.find((node) => node.id === "station-a")).not.toHaveProperty("resourceId");
    expect(disabled.nodes.find((node) => node.id === "station-a")).toMatchObject({ power: { activePowerKw: 18, idlePowerKw: 2.2 } });
    expect(disabled.resources?.some((resource) => resource.kind === "equipment")).toBe(false);
    expect(validatePlantLiteModel(disabled)).toMatchObject({ valid: true });
  });

  it("keeps shared equipment until the last station reference is removed", () => {
    const first = setPlantLiteStationEquipment(createDefaultPlantLiteRequest().model!, "station-a", true);
    const firstStation = first.nodes.find((node): node is Extract<typeof node, { kind: "station" }> =>
      node.id === "station-a" && node.kind === "station");
    const equipmentId = firstStation?.resourceId;
    const shared = structuredClone(first);
    const stationB = shared.nodes.find((node) => node.id === "station-b");
    if (!equipmentId || !stationB || stationB.kind !== "station") throw new Error("missing fixture station");
    delete stationB.power;
    stationB.resourceId = equipmentId;

    const oneReference = setPlantLiteStationEquipment(shared, "station-a", false);
    expect(oneReference.resources?.some((resource) => resource.id === equipmentId)).toBe(true);
    const noReferences = setPlantLiteStationEquipment(oneReference, "station-b", false);
    expect(noReferences.resources?.some((resource) => resource.id === equipmentId)).toBe(false);
  });

  it("creates, shares and cleans worker pools without disturbing equipment resources", () => {
    const baseline = createDefaultPlantLiteRequest().model!;
    const first = setPlantLiteStationWorker(baseline, "station-a", true);
    const firstStation = first.nodes.find((node) => node.id === "station-a");
    if (!firstStation || firstStation.kind !== "station" || !firstStation.workerResourceId) throw new Error("missing worker binding");
    const poolId = firstStation.workerResourceId;
    expect(first.resources?.find((resource) => resource.id === poolId)).toMatchObject({ kind: "worker", capacity: 1, name: "装配工位班组" });

    const second = setPlantLiteStationWorker(first, "station-b", true);
    const shared = bindPlantLiteStationWorkerPool(second, "station-b", poolId);
    expect(shared.nodes.filter((node) => node.kind === "station").map((node) => node.workerResourceId)).toEqual([poolId, poolId]);
    expect(shared.resources?.filter((resource) => resource.kind === "worker")).toHaveLength(1);
    expect(shared.resources?.find((resource) => resource.kind === "agv")).toBeDefined();
    expect(validatePlantLiteModel(shared)).toMatchObject({ valid: true });

    const sharedPool = shared.resources?.find((resource) => resource.id === poolId);
    if (!sharedPool) throw new Error("missing shared worker pool");
    sharedPool.capacity = 3;
    sharedPool.availability = { shifts: [{ startMinute: 360, endMinute: 840 }] };
    const detached = createPlantLiteStationWorkerPool(shared, "station-b");
    const detachedStation = detached.nodes.find((node) => node.id === "station-b");
    const detachedPool = detached.resources?.find((resource) => resource.id === (detachedStation?.kind === "station" ? detachedStation.workerResourceId : undefined));
    expect(detachedPool).toMatchObject({ kind: "worker", capacity: 3, availability: { shifts: [{ startMinute: 360, endMinute: 840 }] } });
    expect(detachedPool?.id).not.toBe(poolId);

    const stillShared = setPlantLiteStationWorker(shared, "station-a", false);
    expect(stillShared.resources?.some((resource) => resource.id === poolId)).toBe(true);
    const removed = setPlantLiteStationWorker(stillShared, "station-b", false);
    expect(removed.resources?.some((resource) => resource.kind === "worker")).toBe(false);
    expect(baseline.nodes.find((node) => node.id === "station-a")).not.toHaveProperty("workerResourceId");
  });

  it("drops deprecated template knobs once the shared start model is restored", () => {
    const restored = resetPlantLiteModel({ ...createDefaultPlantLiteRequest(), agvCount: 9, bufferCapacity: 44 });
    expect(restored).not.toHaveProperty("agvCount");
    expect(restored).not.toHaveProperty("bufferCapacity");
    expect(restored.model).toBeDefined();
  });
});
