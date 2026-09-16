import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createRuntimePackageLodInput } from "../../scripts/runtimePackageLodFixture.mjs";
import { prepareRenderPacket, type RenderPacket } from "../renderPacket.js";
import { buildDeepRuntimePackage, parseDeepRuntimePackage, runtimeContentSha256, runtimePackageSha256,
  buildRuntimePackagePrewarmPlan, serializeDeepRuntimePackage, validateDeepRuntimePackage,
  type BuildDeepRuntimePackageInput } from "./index.js";

const goldenPath = new URL("../../../deep-engine-native/tests/fixtures/runtime-package-lod-v1.json", import.meta.url);
const golden = () => JSON.parse(readFileSync(goldenPath, "utf8"));
const input = () => createRuntimePackageLodInput() as BuildDeepRuntimePackageInput;
function resigned(mutate: (packet: ReturnType<typeof golden>) => void) {
  const value = golden(), packet = value.payloads["scene.lod"];
  mutate(packet);
  value.resources.find((item: { id: string }) => item.id === "scene.lod").contentHash.value = runtimeContentSha256(packet);
  value.packageHash.value = runtimePackageSha256(value);
  return validateDeepRuntimePackage(value);
}

describe("runtime package native LOD input", () => {
  it("rebuilds the shared native golden without changing LOD profiles or author ordering", () => {
    const source = input(), runtime = buildDeepRuntimePackage(source), fixture = golden();
    expect(runtime).toEqual(fixture);
    expect(runtime.packageHash.value).toBe("9bf79d1eb7976d54e59023c5e1e480e2f8da5bb2a16aa282776261e172f17df7");
    expect(`${serializeDeepRuntimePackage(runtime)}\n`).toBe(readFileSync(goldenPath, "utf8"));
    expect(parseDeepRuntimePackage(serializeDeepRuntimePackage(runtime)).valid).toBe(true);
    const packet = fixture.payloads["scene.lod"];
    expect(packet.geometries.map((item: { indices: number[] }) => item.indices.length / 3)).toEqual([4, 2, 1]);
    expect(packet.instances.map((item: { id: string }) => item.id)).toEqual(source.renderPacket.value.instances.map(item => item.id));
    expect(packet.instances.slice(-2).map((item: { id: string }) => item.id)).toEqual(["blend.near", "blend.far"]);
    for (const instance of packet.instances) expect(instance.lod).toEqual(source.renderPacket.value.instances[0]!.lod);
    expect(packet.instances[3].transform[4]).toBe(Math.fround(.28));
    expect(packet.instances[4].transform[0]).toBeLessThan(0);
    expect(packet.textures[0].data.filter((_: number, index: number) => index % 4 === 3)).toEqual([0, 255, 255, 0]);
    const prepared = prepareRenderPacket(source.renderPacket.value);
    expect(prepared.batches[0]!.lod!.levels.map(level => [level.triangles, level.resident])).toEqual([[4, true], [2, false], [1, true]]);
  });
  it("retains optional defaults, resident changes, and two-level profiles", () => {
    expect(resigned(packet => {
      delete packet.instances[0].lod.hysteresisRatio;
      packet.instances[1].lod.levels[1].resident = true;
      packet.instances[2].lod.levels.splice(1, 1);
      delete packet.instances[3].lod;
    }).valid).toBe(true);
    const source = input();
    const profile = source.renderPacket.value.instances[0]!.lod!;
    const value: RenderPacket = { ...source.renderPacket.value, instances: [{ ...source.renderPacket.value.instances[0]!,
      lod: { levels: profile.levels } }] };
    expect(prepareRenderPacket(value).batches[0]!.lod!.hysteresisRatio).toBe(.12);
    expect(buildDeepRuntimePackage({ ...source, renderPacket: { ...source.renderPacket, value } }).payloads["scene.lod"])
      .toMatchObject({ instances: [{ lod: { levels: profile.levels } }] });
  });
  it("owns its profile snapshot and hashes residency/order rather than dropping them", () => {
    const source = input(), runtime = buildDeepRuntimePackage(source), before = serializeDeepRuntimePackage(runtime);
    const levels = source.renderPacket.value.instances[0]!.lod!.levels as { resident?: boolean }[];
    levels[1]!.resident = true;
    expect(serializeDeepRuntimePackage(runtime)).toBe(before);
    expect(buildDeepRuntimePackage(source).packageHash.value).not.toBe(runtime.packageHash.value);
    const tampered = golden();
    tampered.payloads["scene.lod"].instances[0].lod.levels[1].resident = true;
    tampered.packageHash.value = runtimePackageSha256(tampered);
    expect(validateDeepRuntimePackage(tampered)).toMatchObject({ valid: false,
      issues: [{ message: expect.stringContaining("content hash mismatch") }] });
    const reordered = { ...source.renderPacket.value, instances: [...source.renderPacket.value.instances].reverse() };
    expect(buildDeepRuntimePackage({ ...source, renderPacket: { ...source.renderPacket, value: reordered } }).packageHash.value)
      .not.toBe(buildDeepRuntimePackage(source).packageHash.value);
  });
  it("carries baked LOD fallbacks and meshlet ranges into runtime prewarm identity", () => {
    const source = input();
    const plan = buildRuntimePackagePrewarmPlan(buildDeepRuntimePackage(source));
    const render = plan.items.find(item => item.type === "resource" && item.resourceKind === "render-packet");
    const batches = render?.bake?.residencyBatches;
    expect(batches).toBeDefined();
    expect(batches?.every(batch => batch.fallbackGeometry === "lod.low" && batch.levels.map(level => level.geometry)
      .join(",") === "lod.high,lod.middle,lod.low" && batch.levels.map(level => level.meshletOffset).join(",") === "0,2,1"
      && batch.levels.every(level => level.meshletCount === 1 && /^[a-f0-9]{16}$/.test(level.meshletHash)))).toBe(true);
    const updated = input();
    (updated.renderPacket.value.instances[0]!.lod!.levels as { resident?: boolean }[])[1]!.resident = true;
    const changed = buildRuntimePackagePrewarmPlan(buildDeepRuntimePackage(updated));
    const changedRender = changed.items.find(item => item.type === "resource" && item.resourceKind === "render-packet");
    expect(changedRender?.bake?.cacheKey).not.toBe(render?.bake?.cacheKey);
  });
  it.each([
    ["null profile", p => { p.instances[0].lod = null; }],
    ["unknown profile field", p => { p.instances[0].lod.fade = true; }],
    ["missing levels", p => { delete p.instances[0].lod.levels; }],
    ["null levels", p => { p.instances[0].lod.levels = null; }],
    ["one level", p => { p.instances[0].lod.levels.splice(1); }],
    ["nine levels", p => { p.instances[0].lod.levels = Array(9).fill(p.instances[0].lod.levels[0]); }],
    ["null hysteresis", p => { p.instances[0].lod.hysteresisRatio = null; }],
    ["hysteresis type", p => { p.instances[0].lod.hysteresisRatio = "0.12"; }],
    ["hysteresis lower bound", p => { p.instances[0].lod.hysteresisRatio = -.01; }],
    ["hysteresis upper bound", p => { p.instances[0].lod.hysteresisRatio = .5; }],
    ["null level", p => { p.instances[0].lod.levels[1] = null; }],
    ["unknown level field", p => { p.instances[0].lod.levels[1].triangles = 2; }],
    ["missing geometry", p => { delete p.instances[0].lod.levels[1].geometry; }],
    ["dangling geometry", p => { p.instances[0].lod.levels[1].geometry = "absent"; }],
    ["primary mismatch", p => { p.instances[0].lod.levels[0].geometry = "lod.middle"; }],
    ["missing threshold", p => { delete p.instances[0].lod.levels[1].minProjectedDiameterPixels; }],
    ["threshold type", p => { p.instances[0].lod.levels[1].minProjectedDiameterPixels = "80"; }],
    ["threshold lower bound", p => { p.instances[0].lod.levels[1].minProjectedDiameterPixels = -1; }],
    ["threshold upper bound", p => { p.instances[0].lod.levels[0].minProjectedDiameterPixels = 1e9 + 1; }],
    ["equal thresholds", p => { p.instances[0].lod.levels[1].minProjectedDiameterPixels = 180; }],
    ["thresholds collapse in float32", p => { p.instances[0].lod.levels[1].minProjectedDiameterPixels = 180 - 1e-7; }],
    ["threshold underflows to zero", p => { p.instances[0].lod.levels[1].minProjectedDiameterPixels = 1e-50; }],
    ["nonzero last threshold", p => { p.instances[0].lod.levels[2].minProjectedDiameterPixels = 1; }],
    ["equal triangle counts", p => { p.instances[0].lod.levels[1].geometry = "lod.high"; }],
    ["increasing triangle counts", p => { p.instances[0].lod.levels[1].geometry = "lod.low"; }],
    ["missing error", p => { delete p.instances[0].lod.levels[1].geometricError; }],
    ["error type", p => { p.instances[0].lod.levels[1].geometricError = false; }],
    ["error lower bound", p => { p.instances[0].lod.levels[0].geometricError = -.1; }],
    ["error upper bound", p => { p.instances[0].lod.levels[2].geometricError = 1e15 + 1; }],
    ["decreasing errors", p => { p.instances[0].lod.levels[1].geometricError = .5; }],
    ["null residency", p => { p.instances[0].lod.levels[1].resident = null; }],
    ["residency type", p => { p.instances[0].lod.levels[1].resident = 1; }],
    ["nonresident primary", p => { p.instances[0].lod.levels[0].resident = false; }],
    ["nonresident fallback", p => { p.instances[0].lod.levels[2].resident = false; }],
    ["missing lower-level UV", p => { delete p.geometries[2].uv0; }],
    ["missing nonresident-level UV", p => { delete p.geometries[1].uv0; }],
  ] as const)("rejects resigned invalid %s", (_label, mutate) => { expect(resigned(mutate).valid).toBe(false); });
  it("accepts exact numeric bounds and validates tangent/UV1 requirements on every level", () => {
    expect(resigned(p => {
      p.instances[0].lod.hysteresisRatio = .49;
      p.instances[0].lod.levels[0].minProjectedDiameterPixels = 1e9;
      p.instances[0].lod.levels[2].geometricError = 1e15;
    }).valid).toBe(true);
    expect(resigned(p => {
      p.materials[1].baseColorTexture.texCoord = 1;
      for (const geometry of p.geometries) geometry.uv1 = geometry.uv0;
      delete p.geometries[1].uv1;
    }).valid).toBe(false);
    expect(resigned(p => {
      p.textures.push({ ...p.textures[0], id: "normal.grid", semantic: "normal" });
      p.materials[1].normalTexture = { texture: "normal.grid" };
      for (const geometry of p.geometries) geometry.tangents = Array.from({ length: geometry.vertices.length / 6 }, () => [1, 0, 0, 1]).flat();
      delete p.geometries[1].tangents;
    }).valid).toBe(false);
  });
});
