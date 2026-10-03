import { runMetalReflectionFrames } from "./iC23MetalReflectionFrames.js";
/// <reference types="@webgpu/types" />
import { PbrRenderer } from "../src/webgpu/pbrRenderer.js";
import type { RenderView } from "../src/webgpu/pbrRendererTypes.js";
import type { PbrMaterial, RenderPacket } from "../src/renderPacketTypes.js";
import type { DecodedTexture } from "../src/textures/decodedTexture.js";
import { FrameCaptureSession } from "../src/r12/frameCapture.js";
import { isPbrFrameReadbackSnapshot, type PbrFrameReadbackSnapshot } from "../src/webgpu/pbrFrameCaptureReadback.js";
import { decodeHalfFloat } from "../src/rayTracing/probeGridBakeMath.js";
import { uniformFurnaceEquirect } from "../src/webgpu/whiteFurnace.js";
import { sceneShader } from "../src/webgpu/pbrShader.js";
import { composeLayeredMaterialSceneShader } from "../src/webgpu/pbrLayeredMaterialShader.js";
import { sha256Utf8 } from "../src/shaderPackage/hash.js";
import { serializeBrowserRenderPacket, materializeRuntimeRenderPacket } from "../src/runtimePackage/renderPacket.js";
import { normalizeExtendedMaterialParameters } from "../src/shader/materialParameters.js";

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const geometry = { id: "layer-plate", revision: 0,
  vertices: new Float32Array([-2.8, -1.5, 0, 0, 0, 1, 2.8, -1.5, 0, 0, 0, 1, 2.8, 1.5, 0, 0, 0, 1, -2.8, 1.5, 0, 0, 0, 1]),
  uv0: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]), uv1: new Float32Array([1, 0, 0, 0, 0, 1, 1, 1]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]) };
const textures: readonly DecodedTexture[] = [
  { id: "layer-color", revision: 0, semantic: "baseColor", width: 2, height: 2,
    sampler: { magFilter: "nearest", minFilter: "nearest" },
    data: new Uint8Array([255, 70, 15, 128, 40, 220, 100, 128, 60, 80, 255, 128, 230, 190, 35, 128]) },
  { id: "layer-mr", revision: 0, semantic: "metallicRoughness", width: 2, height: 2,
    sampler: { magFilter: "nearest", minFilter: "nearest" },
    data: new Uint8Array([255, 80, 230, 255, 255, 230, 10, 255, 255, 180, 120, 255, 255, 40, 200, 255]) },
];
const base: PbrMaterial = { id: "paint", baseColor: [.35, .45, .6], metallic: .1, roughness: .8, doubleSided: true };
const layer0: PbrMaterial = { ...base, baseColor: [.95, .8, .55], metallic: .8, roughness: .65,
  baseColorTexture: { texture: "layer-color", texCoord: 1, offset: [.13, .04], scale: [.75, .8] },
  metallicRoughnessTexture: { texture: "layer-mr", texCoord: 0 } };
const layer1: PbrMaterial = { ...base, baseColor: [.14, .65, .8], metallic: 0, roughness: .9 };
const view: RenderView = { width: 1920, height: 1080, pixelRatio: 1, eye: [0, 0, 6], target: [0, 0, 0], extent: 6,
  verticalFovRadians: .8, near: .1, far: 50, exposure: 1, roughness: .7, background: [.012, .021, .032], floor: [0, 0, 0],
  authorColorEffects: { colorGrading: { hue: 0, temperature: 0, tint: 0, brightness: 0, contrast: 0, saturation: 0 } } };
const sampleLocations = [500, 650, 800, 960, 1120, 1270, 1420].flatMap(x => [300, 420, 540, 660, 780].map(y => [x, y] as const));
function rgb(frame: PbrFrameReadbackSnapshot, x: number, y: number): number[] {
  const bytes = new DataView(frame.bytes.buffer, frame.bytes.byteOffset, frame.bytes.byteLength);
  return [0, 1, 2].map(channel => decodeHalfFloat(bytes.getUint16(y * frame.bytesPerRow + x * 8 + channel * 2, true)));
}
function packet(material: PbrMaterial, source = textures): RenderPacket {
  return { geometries: [geometry], materials: [material], textures: source,
    instances: [{ id: "paint-plate", geometry: geometry.id, material: material.id, transform: identity }] };
}
const surface = (material: PbrMaterial) => ({ baseColor: material.baseColor, metallic: material.metallic, roughness: material.roughness,
  ...(material.baseColorTexture ? { baseColorTexture: material.baseColorTexture } : {}),
  ...(material.metallicRoughnessTexture ? { metallicRoughnessTexture: material.metallicRoughnessTexture } : {}) });
const layered = (): PbrMaterial => ({ ...base, layered: { layers: [
  { coverage: .65, mode: "replace", surface: surface(layer0) },
  { coverage: .4, mode: "overlay", surface: surface(layer1) },
] } });
/** Uses the real packet owner, ordinary PBR material PSO, HDR capture and presentation. */
export async function runIC23LayeredMaterialProduction(onFrame: (name: string) => Promise<void>, mode: "production" | "rehydrated" | "clearcoat" | "metal-reflection" = "production") {
  const canvas = document.createElement("canvas"); canvas.width = 1920; canvas.height = 1080;
  canvas.style.width = "100vw"; canvas.style.height = "100vh"; document.body.append(canvas);
  const capture = new FrameCaptureSession();
  const renderer = await PbrRenderer.create(canvas, navigator.gpu, new AbortController().signal, {
    environment: { kind: "radiance-hdr", image: uniformFurnaceEquirect(.5, 32, 16),
      options: { specularSize: 64, diffuseSize: 16, sampleCount: 64 } },
    features: { layeredMaterials: true, environment: true, groundPlane: false, groundGrid: false, fog: false,
      ambientOcclusion: false, temporalAa: false, spatialAa: false, bloom: false, vignette: false, occlusionCulling: false },
    shadows: { exactProfile: { cascadeCount: 1, shadowMapSize: 128 } },
    frameCapture: { session: capture, readbacks: { requests: [{ resourceId: "opaque-hdr" }] } },
  });
  const session = renderer.session, device = session.device, frames: unknown[] = [];
  let result: Record<string, any> = {}; device.pushErrorScope("validation");
  const frame = async (material: PbrMaterial, name: string, currentView = view, sources = textures, restored?: RenderPacket) => {
    await renderer.setPacketValidated(restored ?? packet(material, sources));
    const metrics = renderer.render(currentView); if (!metrics) throw Error("Layered production frame did not submit.");
    const image = (await renderer.frameReadbackResults)?.find(isPbrFrameReadbackSnapshot);
    if (!image) throw Error("Layered HDR capture missing.");
    const passes = capture.records().at(-1)?.passes.map(pass => pass.passId) ?? [];
    if (!passes.includes("opaque") || !passes.includes("present")) throw Error("Layered fixture did not execute HDR and present: " + JSON.stringify({ passes, records: capture.records().length, metrics }));
    await device.queue.onSubmittedWorkDone(); await onFrame(name);
    const hdrSha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", image.bytes.slice()))).map(value => value.toString(16).padStart(2, "0")).join("");
    frames.push({ name, hdrSha256, passes, drawCalls: metrics.drawCalls, resources: session.resourceCount,
      resourceBytes: session.resourceMemory.estimatedBytes, cpuSubmitMs: metrics.cpuSubmitMs });
    return image;
  };
  try {
    if (mode === "metal-reflection") {
      result = { ...await runMetalReflectionFrames(frame, base, view, packet), frames, shaderHash: sha256Utf8(composeLayeredMaterialSceneShader(sceneShader)) };
    } else if (mode === "rehydrated") {
      const authored = packet(layered()), json = serializeBrowserRenderPacket(authored);
      const restored = materializeRuntimeRenderPacket(JSON.parse(json), "$.browserPacket");
      const original = await frame(authored.materials[0]!, "author-before-save");
      const reloaded = await frame(restored.materials[0]!, "rehydrated-two-layers", view, textures, restored);
      const samples = sampleLocations.map(([x, y]) => ({ x, y, original: rgb(original, x, y), restored: rgb(reloaded, x, y) }));
      result = { mode, shaderHash: sha256Utf8(composeLayeredMaterialSceneShader(sceneShader)), jsonSha256: sha256Utf8(json),
        frames, samples, maxRestoredDelta: Math.max(...samples.flatMap(sample => sample.original.map((value, channel) => Math.abs(value - sample.restored[channel]!)))) };
    } else if (mode === "clearcoat") {
      const coat = { factor: .7, roughness: .35 };
      const material: PbrMaterial = { ...base, layered: { layers: [
        { coverage: .65, surface: surface(layer0), params: { clearcoat: coat } },
      ] } };
      const baseImage = await frame(base, "coat-base");
      const parent = await frame({ ...layer0, extendedParameters: normalizeExtendedMaterialParameters({ clearcoat: coat }) }, "coat-parent");
      const active = await frame(material, "clearcoat-layer");
      const factor0 = await frame({ ...base, layered: { layers: [
        { coverage: .65, surface: surface(layer0), params: { clearcoat: { factor: 0, roughness: .35 } } },
      ] } }, "coat-factor-zero");
      const stock = await frame({ ...base, layered: { layers: [
        { coverage: .65, surface: surface(layer0) },
      ] } }, "coat-stock-layer");
      const zero = await frame({ ...base, layered: { layers: [
        { coverage: 0, surface: surface(layer0), params: { clearcoat: coat } },
      ] } }, "coat-zero-coverage");
      const json = serializeBrowserRenderPacket(packet(material));
      const restored = materializeRuntimeRenderPacket(JSON.parse(json), "$.browserPacket");
      const restoredImage = await frame(restored.materials[0]!, "coat-restored", view, textures, restored);
      const delta = (a: PbrFrameReadbackSnapshot, b: PbrFrameReadbackSnapshot) => Math.max(...sampleLocations.flatMap(
        ([x,y]) => rgb(a,x,y).map((value, channel) => Math.abs(value-rgb(b,x,y)[channel]!))));
      const combination = sampleLocations.map(([x,y]) => {
        const actual = rgb(active,x,y), p0 = rgb(baseImage,x,y), p1 = rgb(parent,x,y);
        const weight = Math.fround(.65) * (128/255);
        const expected = p0.map((value,channel) => value*(1-weight)+p1[channel]!*weight);
        return {x,y,actual,expected,error:Math.max(...actual.map((value,channel)=>Math.abs(value-expected[channel]!)))};
      });
      result = { mode, shaderHash:sha256Utf8(composeLayeredMaterialSceneShader(sceneShader)), frames, combination,
        maxCombinationError:Math.max(...combination.map(sample=>sample.error)), coatDelta:delta(active,factor0),
        factor0Delta:delta(factor0,stock), zeroDelta:delta(zero,baseImage), maxRestoredDelta:delta(active,restoredImage) };
    } else {
    const baseImage = await frame(base, "base"), a = await frame(layer0, "parent-textured"), b = await frame(layer1, "parent-coating");
    const both = await frame(layered(), "two-layers");
    const combination = sampleLocations.map(([x, y]) => {
      const p0 = rgb(baseImage, x, y), p1 = rgb(a, x, y), p2 = rgb(b, x, y), actual = rgb(both, x, y);
      const expected = p0.map((value, channel) => {
        const weight = Math.fround(.65) * (128 / 255), first = value * (1 - weight) + p1[channel]! * weight;
        const secondWeight = Math.fround(.4) * Math.min(1, Math.max(0, p2[channel]!));
        return first * (1 - secondWeight) + p2[channel]! * secondWeight;
      });
      return { x, y, actual, expected, error: Math.max(...actual.map((value, channel) => Math.abs(value - expected[channel]!))) };
    });
    const untextured: PbrMaterial = { ...base, layered: { layers: [{ coverage: .65,
      surface: { baseColor: layer0.baseColor, metallic: layer0.metallic, roughness: layer0.roughness } },
      { coverage: .4, mode: "overlay", surface: surface(layer1) }] } };
    const noMaps = await frame(untextured, "layers-without-maps");
    const textureDelta = Math.max(...sampleLocations.flatMap(([x, y]) => rgb(noMaps, x, y).map((value, channel) => Math.abs(value - rgb(both, x, y)[channel]!))));
    const zero = await frame({ ...base, layered: { layers: [{ coverage: 0, surface: surface(layer0) }] } }, "zero-coverage");
    const zeroDelta = Math.max(...sampleLocations.flatMap(([x, y]) => rgb(zero, x, y).map((value, channel) => Math.abs(value - rgb(baseImage, x, y)[channel]!))));
    await renderer.setPacketValidated(packet(layered())); const resident = session.resourceCount;
    const invalid: PbrMaterial = { ...base, layered: { layers: [{ coverage: 2 }] } };
    let invalidRetained = false; try { await renderer.setPacketValidated(packet(invalid)); } catch { invalidRetained = session.resourceCount === resident; }
    const aborted = new AbortController(); aborted.abort();
    let cancelledRetained = false; try { await renderer.setPacketValidated(packet(base), aborted.signal); } catch { cancelledRetained = session.resourceCount === resident; }
    const alphaZeroTextures = textures.map(texture => texture.id === "layer-color" ? { ...texture, revision: 1,
      data: texture.data.map((value, index) => index % 4 === 3 ? 0 : value) } : texture);
    const transparentLayer = await frame({ ...base, layered: { layers: [{ coverage: 1, surface: surface(layer0) }] } }, "texture-alpha-zero", view, alphaZeroTextures);
    const alphaZeroDelta = Math.max(...sampleLocations.flatMap(([x, y]) => rgb(transparentLayer, x, y).map((value, channel) => Math.abs(value - rgb(baseImage, x, y)[channel]!))));
    const furnaceView: RenderView = { ...view, environmentIntensity: 1, lights: { directional: [] } };
    const white: PbrMaterial = { ...base, baseColor: [1, 1, 1], metallic: 0, roughness: 1, ior: 1 };
    const whiteBase = await frame(white, "furnace-base", furnaceView);
    const whiteLayered = await frame({ ...white, layered: { base: { ior: 1 }, layers: [
      { params: { ior: 1 }, coverage: .65, surface: { baseColor: [1, 1, 1], metallic: 0, roughness: 1 } },
      { params: { ior: 1 }, coverage: .4, mode: "overlay", surface: { baseColor: [1, 1, 1], metallic: 0, roughness: 1 } },
    ] } }, "furnace-two-layers", furnaceView);
    const furnace = sampleLocations.map(([x, y]) => ({ x, y, base: rgb(whiteBase, x, y), layered: rgb(whiteLayered, x, y) }));
    const maxFurnaceError = Math.max(...furnace.flatMap(sample => sample.layered.map(value => Math.abs(value - .5))));
    const maxFurnaceLayerDelta = Math.max(...furnace.flatMap(sample => sample.layered.map((value, channel) => Math.abs(value - sample.base[channel]!))));
    result = { shaderHash: sha256Utf8(composeLayeredMaterialSceneShader(sceneShader)), frames, combination,
      maxCombinationError: Math.max(...combination.map(sample => sample.error)), textureDelta, zeroDelta, alphaZeroDelta,
      invalidRetained, cancelledRetained, requiredTextures: device.limits.maxSampledTexturesPerShaderStage,
      furnace, maxFurnaceError, maxFurnaceLayerDelta };
    }
  } catch (error) { result.failure = error instanceof Error ? `${error.message}\n${error.stack}` : String(error); }
  finally {
    result.validationError = (await device.popErrorScope())?.message; result.errors = session.diagnostics;
    renderer.dispose(); result.remainingResources = session.resourceCount;
  }
  const clean = !result.failure && !result.validationError && result.errors.length === 0 && result.remainingResources === 0;
  result.passed = mode === "metal-reflection" ? clean && result.passedMath : mode === "clearcoat" ? clean && result.maxCombinationError < .002 && result.coatDelta > .001
    && result.factor0Delta === 0 && result.zeroDelta === 0 && result.maxRestoredDelta === 0
    : mode === "rehydrated" ? clean && result.maxRestoredDelta === 0 : clean
    && result.maxCombinationError < .002 && result.textureDelta > .01 && result.zeroDelta === 0 && result.alphaZeroDelta === 0
    && result.invalidRetained && result.cancelledRetained;
  if (mode === "production") result.passed &&= result.maxFurnaceError < .04 && result.maxFurnaceLayerDelta < .001;
  return result;
}
