import { describe, expect, it } from "vitest";
import type { ModelRecord } from "@bim-studio/contracts";
import type { LoadedSceneModel } from "../viewer/ViewerEngine";
import { sceneModelRows } from "./sceneModelRows";

describe("scene instance rows", () => {
  it("keeps every instance independently addressable and an unloaded asset entry", () => {
    const assets = [{ id: "source", name: "resource.glb" }, { id: "unloaded", name: "next.glb" }] as ModelRecord[];
    const loaded = [{ id: "source", name: "Original", kind: "model" }, { id: "alias", assetModelId: "source", name: "Duplicate", kind: "model" }] as LoadedSceneModel[];
    const rows = sceneModelRows(assets, loaded);
    expect(rows.map(row => row.model.id)).toEqual(["source", "alias", "unloaded"]);
    expect(rows[1]?.model.name).toBe("Duplicate");
    expect(rows[1]?.asset).toBe(assets[0]);
    expect(rows[2]?.loaded).toBeUndefined();
    expect(assets[0]?.name).toBe("resource.glb");
  });
});
