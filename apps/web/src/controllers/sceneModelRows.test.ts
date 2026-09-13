import { describe, expect, it } from "vitest";
import type { ModelRecord } from "@bim-studio/contracts";
import type { LoadedSceneModel } from "../viewer/ViewerEngine";
import { sceneModelRows } from "./sceneModelRows";

describe("scene instance rows", () => {
  it("shows only scene instances and omits unused project assets", () => {
    const assets = [{ id: "original" }, { id: "replacement" }] as ModelRecord[];
    const rows = sceneModelRows(assets, [{ id: "original", assetModelId: "replacement", kind: "model" }] as LoadedSceneModel[]);
    expect(rows.map(row => row.rowKey)).toEqual(["instance:original"]);
    expect(new Set(rows.map(row => row.rowKey)).size).toBe(rows.length);
  });
  it("keeps every scene instance independently addressable without leaking project inventory", () => {
    const assets = [{ id: "source", name: "resource.glb" }, { id: "unloaded", name: "next.glb" }] as ModelRecord[];
    const loaded = [{ id: "source", name: "Original", kind: "model" }, { id: "alias", assetModelId: "source", name: "Duplicate", kind: "model" }] as LoadedSceneModel[];
    const rows = sceneModelRows(assets, loaded);
    expect(rows.map(row => row.model.id)).toEqual(["source", "alias"]);
    expect(rows[1]?.model.name).toBe("Duplicate");
    expect(rows[1]?.asset).toBe(assets[0]);
    expect(assets[0]?.name).toBe("resource.glb");
  });
});
