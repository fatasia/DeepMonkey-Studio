import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRuntimePackageLodInput } from "../../scripts/runtimePackageLodFixture.mjs";
import { createRuntimePackageAuthorLodInput } from "../../scripts/runtimePackageAuthorLodFixture.mjs";
import { prepareRenderPacket, type RenderAuthorSelectedLodProfile } from "../renderPacket.js";
import { bakeRenderPacketForResidency } from "../assetBakeResidency.js";
import { materializeRuntimeRenderPacket, serializeBrowserRenderPacket } from "./renderPacket.js";
import { buildDeepRuntimePackage, buildRuntimePackagePrewarmPlan, serializeDeepRuntimePackage, type BuildDeepRuntimePackageInput } from "./index.js";

function input(selectedLevels: number[] = [0, 2]): BuildDeepRuntimePackageInput {
  const source = createRuntimePackageLodInput() as BuildDeepRuntimePackageInput;
  const profile: RenderAuthorSelectedLodProfile = { strategy: "author-selected", revision: 4,
    levels: ["lod.high", "lod.middle", "lod.low"].map((geometry, index) => ({ geometry, distance: index * 10, hysteresis: .1 })),
    selectedLevels };
  return { ...source, renderPacket: { ...source.renderPacket,
    value: { ...source.renderPacket.value, instances: source.renderPacket.value.instances.map(instance => ({ ...instance, lod: profile })) } } };
}

describe("author-selected LOD runtime and bake evidence", () => {
  it("reproduces the shared Native golden byte for byte", () => {
    const runtime = buildDeepRuntimePackage(createRuntimePackageAuthorLodInput() as BuildDeepRuntimePackageInput);
    const bytes = readFileSync(new URL("../../../deep-engine-native/tests/fixtures/runtime-package-author-lod-v1.json", import.meta.url), "utf8");
    expect(`${serializeDeepRuntimePackage(runtime)}\n`).toBe(bytes);
    expect(runtime.packageHash.value).toBe("7089eba4ab7d3f5dfc8eaf49904b7367fdcd75db4d978075fa60aee14326744c");
  });
  it.each([{ selected: [] }, { selected: [0] }, { selected: [0, 2] }])("retains explicit selection $selected through Browser JSON, preparation and prewarm", ({ selected }) => {
    const source = input(selected), packet = source.renderPacket.value;
    const rehydrated = materializeRuntimeRenderPacket(JSON.parse(serializeBrowserRenderPacket(packet)), "$.packet");
    const prepared = prepareRenderPacket(rehydrated);
    expect(prepared.batches.every(batch => batch.lod?.strategy === "author-selected"
      && JSON.stringify(batch.lod.selectedLevels) === JSON.stringify(selected))).toBe(true);
    const baked = bakeRenderPacketForResidency(rehydrated);
    for (const batch of baked.batches) {
      expect(batch).toMatchObject({ strategy: "author-selected", revision: 4, selectedLevels: selected });
      expect(batch).not.toHaveProperty("fallbackGeometry");
      expect(batch.levels.map(level => level.geometry)).toEqual(["lod.high", "lod.middle", "lod.low"]);
      expect(batch.levels.every(level => level.meshletCount > 0 && !Object.hasOwn(level, "geometricError")
        && !Object.hasOwn(level, "minProjectedDiameterPixels"))).toBe(true);
    }
    const plan = buildRuntimePackagePrewarmPlan(buildDeepRuntimePackage(source));
    const evidence = plan.items.find(item => item.type === "resource" && item.resourceKind === "render-packet");
    expect(evidence?.type === "resource" && evidence.bake?.residencyBatches).toEqual(baked.batches);
  });

  it("owns the selected-level snapshot and includes selection and revision in cache identity", () => {
    const selected = [0], source = input(selected), packet = source.renderPacket.value;
    const first = bakeRenderPacketForResidency(packet);
    selected[0] = 2;
    expect(first.batches[0]).toMatchObject({ selectedLevels: [0] });
    expect(bakeRenderPacketForResidency(packet).cacheKey).not.toBe(first.cacheKey);
    const revised = { ...packet, instances: packet.instances.map(instance => ({ ...instance,
      lod: { ...instance.lod as RenderAuthorSelectedLodProfile, revision: 5 } })) };
    expect(bakeRenderPacketForResidency(revised).cacheKey).not.toBe(bakeRenderPacketForResidency(packet).cacheKey);
  });

  it.each([
    ["unknown strategy", (p: Record<string, unknown>) => { p.strategy = "distance"; }],
    ["null strategy", (p: Record<string, unknown>) => { p.strategy = null; }],
    ["unknown field", (p: Record<string, unknown>) => { p.hysteresisRatio = .1; }],
    ["missing revision", (p: Record<string, unknown>) => { delete p.revision; }],
    ["fractional revision", (p: Record<string, unknown>) => { p.revision = 1.5; }],
    ["null selection", (p: Record<string, unknown>) => { p.selectedLevels = null; }],
    ["duplicate selection", (p: Record<string, unknown>) => { p.selectedLevels = [0, 0]; }],
    ["unordered selection", (p: Record<string, unknown>) => { p.selectedLevels = [2, 0]; }],
    ["out of range", (p: Record<string, unknown>) => { p.selectedLevels = [3]; }],
    ["fractional selection", (p: Record<string, unknown>) => { p.selectedLevels = [.5]; }],
  ])("rejects %s before runtime materialization", (_label, mutate) => {
    const encoded = JSON.parse(serializeBrowserRenderPacket(input().renderPacket.value));
    mutate(encoded.instances[0].lod);
    expect(() => materializeRuntimeRenderPacket(encoded, "$.packet")).toThrow();
  });
});
