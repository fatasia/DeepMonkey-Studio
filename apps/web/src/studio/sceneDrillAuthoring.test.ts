import { describe, expect, it } from "vitest";
import { applySceneDrills, drillConflict, drillDestinations, savedDrillDestination, suggestSceneDrills, undoSceneDrills } from "./sceneDrillAuthoring";

const sources = [{ label: "一号车间", target: { kind: "object" as const, modelId: "workshop" } }, { label: "机器人", target: { kind: "object" as const, modelId: "robot" } }];
const destinations = drillDestinations("campus", [{ id: "campus", name: "园区" }, { id: "workshop", name: "一号车间 · 楼层拆解" }], []);
describe("scene drill authoring", () => {
  it("matches only an unambiguous named level and never invents missing destinations", () => {
    const rows = suggestSceneDrills(sources, destinations);
    expect(rows[0]).toMatchObject({ destinationKey: "scene:workshop", reason: "matched" });
    expect(rows[1]).toMatchObject({ destinationKey: "", reason: "unmatched" });
    expect(destinations.some((item) => item.key === "scene:campus")).toBe(false);
    expect(suggestSceneDrills(sources, [...destinations, { ...destinations[0]!, key: "duplicate" }])[0]!.reason).toBe("ambiguous");
    expect(suggestSceneDrills([{ label: "总装园区 / · · 一号车间", target: { kind: "object", modelId: "campus-model", layerId: "workshop-layer" } }], destinations)[0]!.destinationKey).toBe("scene:workshop");
  });
  it("generates executable actions idempotently and preserves existing click handlers", () => {
    const rows = suggestSceneDrills(sources, destinations);
    const first = applySceneDrills(rows, destinations, []);
    expect(first.added).toHaveLength(1);
    expect(first.added[0]).toMatchObject({ target: sources[0]!.target, actions: [{ type: "navigateScene", sceneId: "workshop", newTab: false }] });
    expect(applySceneDrills(rows, destinations, first.next)).toMatchObject({ added: [], skipped: 1 });
    expect(savedDrillDestination(sources[0]!, JSON.parse(JSON.stringify(first.next)))).toBe("scene:workshop");
  });
  it("undo removes only the unchanged batch and preserves later edits and unrelated events", () => {
    const rows = suggestSceneDrills(sources, destinations).map((item) => ({ ...item, destinationKey: "focus" }));
    const batch = applySceneDrills(rows, destinations, []);
    const edited = { ...batch.added[0]!, name: "User edited" };
    const external = { ...batch.added[1]!, id: "external" };
    expect(undoSceneDrills([edited, batch.added[1]!, external], batch.added)).toEqual([edited, external]);
  });
  it("keeps disabled drill identities reserved in both the authoring UI and generator", () => {
    const rows = suggestSceneDrills(sources, destinations);
    const first = applySceneDrills(rows, destinations, []);
    const disabled = { ...first.added[0]!, enabled: false, name: "保留手工修改" };
    expect(drillConflict(sources[0]!, [disabled])).toBe(true);
    expect(applySceneDrills(rows, destinations, [disabled])).toEqual({ next: [disabled], added: [], skipped: 1 });
    expect(drillConflict(sources[1]!, [disabled])).toBe(false);
  });
});
