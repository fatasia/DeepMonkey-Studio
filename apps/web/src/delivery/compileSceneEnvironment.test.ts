import { describe, expect, it } from "vitest";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { parseDeepRuntimePackage, runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import { compileSceneEnvironment } from "./compileSceneEnvironment";
import { compileSceneRuntimePackage } from "./compileSceneRuntimePackage";
import { assessCompiledScenePublication } from "./scenePublicationCompatibility";

const environment = () => ({ gridVisible: false, skybox: "none" as const, backgroundColor: "#172126" });
const scene = (): SceneSnapshot => ({ schemaVersion: 1, id: "solid", projectId: "p", name: "solid", models: [], primitives: [], measurements: [],
  camera: { mode: "orbit", position: { x: 0, y: 1, z: 5 }, target: { x: 0, y: 0, z: 0 } },
  environment: environment(), createdAt: "", updatedAt: "" });
const options = { packageId: "scene.solid", packageVersion: "1.0.0", loadModel: async () => new Uint8Array() };
describe("authored solid environment", () => {
  it("compiles the built-in studio IBL with authored background and default lighting", async () => {
    const source = scene();
    source.environment = { gridVisible: true, skybox: "studio", backgroundColor: "#202a31",
      environmentAsBackground: false, environmentIntensity: 1 };
    source.weather = "sunny";
    source.lighting = { enabled: true, intensity: 1, shadowsEnabled: true, reflectionsEnabled: true,
      globalIlluminationEnabled: true, globalIlluminationIntensity: .32, lights: [{ id: "sun-default", name: "主方向光",
        type: "directional", color: "#ffffff", target: { x: 0, y: 0, z: 0 }, enabled: true,
        position: { x: 18, y: 28, z: 12 }, intensity: 2.2, castShadow: true }] };
    const result = await compileSceneRuntimePackage(source, options);
    expect(result.evidence.recipe).toBe("deep-scene-static-compile-v13");
    expect(result.evidence.deferredSceneFields).toEqual([]);
    expect(result.runtimePackage.payloads["scene.environment"]).toMatchObject({ schemaVersion: 8,
      kind: "solid-background-builtin-ibl", outputTransform: "native-aces-studio-v8", backgroundSrgb: [32 / 255, 42 / 255, 49 / 255] });
  });
  it("keeps authored GI intensity through the Native environment payload", async () => {
    const source = scene();
    source.environment = { gridVisible: true, skybox: "studio", backgroundColor: "#202a31" };
    source.lighting = { enabled: true, intensity: 1, shadowsEnabled: true, reflectionsEnabled: true,
      globalIlluminationEnabled: true, globalIlluminationIntensity: .8, lights: [{ id: "sun-default", name: "主方向光",
        type: "directional", color: "#ffffff", target: { x: 0, y: 0, z: 0 }, enabled: true,
        position: { x: 18, y: 28, z: 12 }, intensity: 2.2, castShadow: true }] };
    const compiled = await compileSceneRuntimePackage(source, options);
    const report = assessCompiledScenePublication(source, { compilation: compiled.evidence,
      fixtureId: "native-gi", platform: "windows-x64" });
    expect(compiled.runtimePackage.payloads["scene.environment"]).toMatchObject({
      lighting: { globalIlluminationIntensity: .8 },
    });
    expect(report.items).toContainEqual(expect.objectContaining({ path: "lighting", status: "blocked" }));
    // 本测试不注入 Native 窗口证据，故整体仍需证据门禁；GI 本身不再是
    // 未消费字段，正式候选补齐窗口证据后即可进入 ready。
    expect(report.status).toBe("blocked");
  });
  it("keeps background separate from GI and binds its actual bytes in the graph", async () => {
    const source = scene(), before = structuredClone(source);
    const result = await compileSceneRuntimePackage(source, options);
    expect(source).toEqual(before);
    expect(result.evidence.recipe).toBe("deep-scene-static-compile-v6");
    expect(result.evidence.deferredSceneFields).not.toContain("environment");
    expect(parseDeepRuntimePackage(result.packageJson).valid).toBe(true);
    const payload = result.runtimePackage.payloads["scene.environment"];
    expect(payload).toEqual({ schema: "deep-engine.solid-environment", schemaVersion: 1, id: "scene.environment", revision: 1,
      kind: "solid-background-no-ibl", outputTransform: "native-aces-v1", backgroundSrgb: [23 / 255, 33 / 255, 38 / 255] });
    const e = result.evidence, runtime = result.runtimePackage;
    expect(e.compileGraphHash).toBe(runtimeContentSha256({ recipe: e.recipe, sourceSemanticHash: e.sourceSemanticHash,
      sourceAssets: e.sourceAssets, packageId: runtime.packageId, packageVersion: runtime.packageVersion,
      maxSourceBytes: e.maxSourceBytes, localCoordinates: e.localCoordinates, environmentHash: runtimeContentSha256(payload),
      cameraHash: runtime.resources.find(r => r.kind === "scene-camera")!.contentHash.value,
      renderPacketHash: runtime.resources.find(r => r.kind === "render-packet")!.contentHash.value }));
    const changed = scene(); changed.environment!.backgroundColor = "#445566";
    expect((await compileSceneRuntimePackage(changed, options)).evidence.compileGraphHash).not.toBe(e.compileGraphHash);
    Object.assign(source, { lighting: { enabled: true, intensity: 1, globalIlluminationEnabled: true } });
    expect((await compileSceneRuntimePackage(source, options)).evidence.deferredSceneFields).toContain("lighting");
  });
  it.each([{ gridVisible: "yes" }, { skybox: "day" }, { environmentMapUrl: "/hdr" }, { backgroundColor: "red" },
    { backgroundColor: "#1234" }, { environmentIntensity: -1 }, { environmentIntensity: NaN }, { exposure: 2 },
    { environmentAsBackground: 1 }, { environmentMapName: 3 }])("keeps unsupported author semantics blocked: %o", async patch => {
    const value = { ...environment(), ...patch };
    expect(compileSceneEnvironment(value)).toBeUndefined();
    if ("environmentIntensity" in value && Number.isNaN(value.environmentIntensity)) return;
    const source = scene(); Object.assign(source.environment!, patch);
    const result = await compileSceneRuntimePackage(source, options);
    expect(result.evidence.deferredSceneFields).toContain("environment");
  });
  it("does not infer GI off from none and allows inactive environment metadata", () => {
    expect(compileSceneEnvironment({ ...environment(), environmentMapUrl: "", environmentMapName: "unused.hdr",
      environmentIntensity: 0.7, environmentAsBackground: true })).toEqual(compileSceneEnvironment(environment()));
  });
  it("keeps auxiliary-grid visibility independent from the skybox and lowers it into Native draw data", async () => {
    const withoutGrid = scene();
    withoutGrid.environment = { gridVisible: false, skybox: "studio", backgroundColor: "#202a31" };
    const studio = await compileSceneRuntimePackage(withoutGrid, options);
    expect(studio.evidence.recipe).toBe("deep-scene-static-compile-v13");
    expect(studio.runtimePackage.payloads["scene.main"]).toMatchObject({ instances: [] });

    const withGrid = scene();
    withGrid.environment = { gridVisible: true, skybox: "none", backgroundColor: "#202a31" };
    const plain = await compileSceneRuntimePackage(withGrid, options);
    expect(plain.evidence.recipe).toBe("deep-scene-static-compile-v6");
    const packet = plain.runtimePackage.payloads["scene.main"] as { instances: Array<{ id: string; castShadow?: boolean }> };
    expect(packet.instances.map(instance => instance.id)).toEqual([
      "scene.auxiliary-grid.instance.minor", "scene.auxiliary-grid.instance.major",
      "scene.auxiliary-grid.instance.axis-x", "scene.auxiliary-grid.instance.axis-z",
    ]);
    expect(packet.instances.every(instance => instance.castShadow === false)).toBe(true);
    expect(parseDeepRuntimePackage(plain.packageJson).valid).toBe(true);
  });
  it("rejects erased or forged field evidence and old recipes with environment claims", async () => {
    const source = scene(), { evidence } = await compileSceneRuntimePackage(source, options);
    const assess = (compilation: typeof evidence) => assessCompiledScenePublication(source, { compilation, fixtureId: "fixture", platform: "windows-x64" });
    expect(assess(evidence).items.find(item => item.path === "environment")?.capability).toBe("deep.scene.solid-environment.v1");
    const erased = { ...evidence, compiledSceneFields: evidence.compiledSceneFields.filter(field => field.field !== "environment") };
    expect(assess(erased).items.some(item => item.path === "environment" && item.status === "blocked")).toBe(true);
    expect(assess({ ...evidence, recipe: "deep-scene-static-compile-v5" }).status).toBe("blocked");
  });
});

describe("authored weather fog compilation", () => {
  const fogScene = (weather: unknown): SceneSnapshot => ({ ...scene(), weather } as SceneSnapshot);
  it("compiles particle-free weathers into the versioned fog environment and keeps weather deferred", async () => {
    const result = await compileSceneRuntimePackage(fogScene("fog"), options);
    expect(result.evidence.recipe).toBe("deep-scene-static-compile-v12");
    const payload = result.runtimePackage.payloads["scene.environment"] as Record<string, unknown>;
    expect(payload.schemaVersion).toBe(7);
    expect(payload.outputTransform).toBe("native-aces-fog-v7");
    const fog = payload.fog as { schemaVersion: number; kind: string; colorLinearRgb: number[]; density: number };
    expect(fog.schemaVersion).toBe(1);
    expect(fog.kind).toBe("exp2");
    expect(fog.density).toBe(0.018);
    // #aab4b7 的 sRGB→linear 值（与灯光颜色同一变换）。
    expect(fog.colorLinearRgb[0]).toBeCloseTo(((170 / 255 + 0.055) / 1.055) ** 2.4, 6);
    expect(fog.colorLinearRgb[1]).toBeCloseTo(((180 / 255 + 0.055) / 1.055) ** 2.4, 6);
    expect(fog.colorLinearRgb[2]).toBeCloseTo(((183 / 255 + 0.055) / 1.055) ** 2.4, 6);
    expect(parseDeepRuntimePackage(result.packageJson).valid).toBe(true);
    // weather 只被部分消费（粒子/曝光因子未接），必须继续 deferred 阻断发布。
    expect(result.evidence.deferredSceneFields).toContain("weather");
    expect(result.evidence.deferredSceneFields).not.toContain("environment");
  });
  it.each(["sunny", "cloudy", "fog"] as const)("compiles fog for %s with contract values", async weather => {
    const payload = (await compileSceneRuntimePackage(fogScene(weather), options)).runtimePackage.payloads["scene.environment"] as { schemaVersion: number; fog?: { density: number } };
    expect(payload.schemaVersion).toBe(7);
    expect(payload.fog?.density).toBeGreaterThan(0);
  });
  it.each(["rain", "snow", "storm"] as const)("keeps particle weathers fully deferred without fog: %s", async weather => {
    const result = await compileSceneRuntimePackage(fogScene(weather), options);
    const payload = result.runtimePackage.payloads["scene.environment"] as { schemaVersion: number; fog?: unknown };
    expect(payload.schemaVersion).not.toBe(7);
    expect(payload.fog).toBeUndefined();
    expect(result.evidence.deferredSceneFields).toContain("weather");
  });
  it("does not compile fog when the weather field is absent, keeping old packages byte-stable", async () => {
    const result = await compileSceneRuntimePackage(scene(), options);
    const payload = result.runtimePackage.payloads["scene.environment"] as { schemaVersion: number; fog?: unknown };
    expect(payload.schemaVersion).toBe(1);
    expect(payload.fog).toBeUndefined();
    expect(result.evidence.recipe).toBe("deep-scene-static-compile-v6");
  });
  it("supports the fog recipe in the publication compatibility check", async () => {
    const source = fogScene("fog"), { evidence } = await compileSceneRuntimePackage(source, options);
    const report = assessCompiledScenePublication(source, { compilation: evidence, fixtureId: "fixture", platform: "windows-x64" });
    expect(report.items.find(item => item.path === "environment")?.capability).toBe("deep.scene.solid-environment.v1");
    expect(report.items.some(item => item.path === "weather" && item.capability === "deep.scene.uncompiled.v1")).toBe(true);
  });
});
