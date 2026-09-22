import { describe, expect, it } from "vitest";
import type { SceneRootLayerRef } from "@bim-studio/contracts";
import { moveSceneRootLayers, normalizeSceneRootLayerOrder, sortSceneRootLayers } from "./sceneRootLayerOrder";

const object = (id: string): SceneRootLayerRef => ({ kind: "object", id });
const group: SceneRootLayerRef = { kind: "group", id: "group" };
const available = [group, object("model"), object("primitive")];
describe("scene root order", () => {
  it("keeps legacy order and appends new rows after existing explicit order", () => {
    expect(normalizeSceneRootLayerOrder(undefined, available)).toEqual(available);
    expect(normalizeSceneRootLayerOrder([object("primitive"), object("deleted"), object("primitive")], available))
      .toEqual([object("primitive"), group, object("model")]);
  });
  it("reorders across object kinds and groups without changing payload or transforms", () => {
    const rows = available.map(ref => Object.freeze({ ref, transform: Object.freeze({ x: 1, y: 2, z: 3 }) }));
    const sorted = sortSceneRootLayers(rows, [object("primitive"), object("model"), group], row => row.ref);
    expect(sorted).toEqual([rows[2], rows[1], rows[0]]);
    expect(sorted[0]).toBe(rows[2]);
    expect(rows.map(row => row.ref)).toEqual(available);
  });
  it("preserves current relative order for reversed multi-selection and handles root append", () => {
    expect(moveSceneRootLayers(undefined, available, [object("primitive"), object("model")], group))
      .toEqual([object("model"), object("primitive"), group]);
    expect(moveSceneRootLayers(undefined, available, [group])).toEqual([object("model"), object("primitive"), group]);
  });
  it("does not move a block onto itself or an invalid destination", () => {
    expect(moveSceneRootLayers(undefined, available, [group], group)).toEqual(available);
    expect(moveSceneRootLayers(undefined, available, [group], object("gone"))).toEqual(available);
    expect(moveSceneRootLayers(undefined, available, [object("gone")])).toEqual(available);
  });
  it("distinguishes same id across row kinds and deduplicates stale stored references", () => {
    const refs = [group, object("group")];
    expect(normalizeSceneRootLayerOrder([object("group"), group], refs)).toEqual([object("group"), group]);
  });
});
