import { describe, expect, it } from "vitest";
import type { ApplicationDocument, ScriptModule } from "@bim-studio/contracts";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import { lockedBehaviorScriptChange } from "./behaviorScriptLockPolicy";

const script = { id: "script", name: "Pump", target: { kind: "object", id: "pump" }, code: "original" } as ScriptModule;
function document(locked: boolean) {
  return { scripts: [script], pages: [], scenes: [{ id: "scene", primitives: [{ modelId: "pump", locked }], models: [] }] } as unknown as ApplicationDocument;
}
describe("behavior target locks", () => {
  it("allows an unchanged locked script in a batch while protecting changes and deletion", () => {
    expect(lockedBehaviorScriptChange(document(true), [script])).toBeUndefined();
    expect(lockedBehaviorScriptChange(document(true), [{ ...script, code: "changed" }])).toBeDefined();
    expect(lockedBehaviorScriptChange(document(true), [])).toBe(script);
  });
  it("uses current viewer locks over the persisted snapshot in the active scene", () => {
    let locked = true;
    const engine = { listModels: () => [{ id: "pump" }], isModelLocked: () => locked } as unknown as ViewerEngine;
    expect(lockedBehaviorScriptChange(document(false), [], engine, "scene")).toBe(script);
    locked = false;
    expect(lockedBehaviorScriptChange(document(true), [], engine, "scene")).toBeUndefined();
  });
  it("protects stable BIM component targets with inherited layer locks", () => {
    const target = { ...script, target: { kind: "object" as const, id: "pump:valve" } };
    const source = { ...document(false), scripts: [target] };
    const engine = { searchComponents: () => [{ stableId: "pump:valve", modelId: "pump", id: "root/valve" }],
      isLayerLocked: () => true } as unknown as ViewerEngine;
    expect(lockedBehaviorScriptChange(source, [], engine, "scene")).toBe(target);
  });
});
