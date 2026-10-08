/// <reference types="@webgpu/types" />
import { PbrRenderer, type RenderView } from "../src/webgpu/pbrRenderer.js";
import type { PbrMaterial, RenderPacket } from "../src/renderPacket.js";
import { FrameCaptureSession } from "../src/r12/frameCapture.js";
import { bounded, readSharedDeepFrame } from "./c8SharedSceneReadback.js";

const WIDTH = 160, HEIGHT = 96, identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const slot = { texture: "specular", texCoord: 0 as const };
let textureRevision = 0;
function packet(fields: Partial<PbrMaterial>, semantic: "specular" | "specularColor" = "specularColor"): RenderPacket {
  return { geometries: [{ id: "quad", revision: 1, vertices: new Float32Array([
    -2, -2, 0, 0, 0, 1, 2, -2, 0, 0, 0, 1, 2, 2, 0, 0, 0, 1, -2, 2, 0, 0, 0, 1,
  ]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]), uv0: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    uv1: new Float32Array([1, 1, 0, 1, 0, 0, 1, 0]) }],
    materials: [{ id: "surface", baseColor: [0, 0, 0], roughness: .3, metallic: 0, ior: 1.45, doubleSided: true, ...fields }],
    instances: [{ id: "quad", geometry: "quad", material: "surface", transform: identity, castShadow: false }],
    textures: [{ id: "specular", revision: ++textureRevision, width: 2, height: 1, semantic,
      data: semantic === "specularColor" ? new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255])
        : new Uint8Array([255, 255, 255, 0, 255, 255, 255, 255]),
      sampler: { minFilter: "nearest", magFilter: "nearest", mipmapFilter: "nearest" } }] };
}
function deformed(source: RenderPacket): RenderPacket {
  const positions = new Float32Array([-2,-2,0,2,-2,0,2,2,0,-2,2,0]);
  const normals = new Float32Array([0,0,1,0,0,1,0,0,1,0,0,1]);
  return { ...source, instances: source.instances.map(instance => ({ ...instance, pose: "pose" })),
    deformation: { sources: [{ id: "source", revision: 1, geometry: "quad", kind: "morph", semantics: "three-r185",
      morph: { revision: 1, positions, normals, primitive: { id: "primitive", sourceMeshIndex: 0,
        sourcePrimitiveIndex: 0, vertexCount: 4, targets: [{ index: 0, name: "move",
          positionDeltas: new Float32Array(12).fill(0) }] } } }],
      poses: [{ id: "pose", source: "source", revision: 1, morphWeights: { revision: 1, values: new Float32Array([1]) } }] } };
}
const mean = (hdr: readonly number[], x0: number, x1: number) => {
  let value = 0, count = 0;
  for (let y = 35; y < 61; y++) for (let x = x0; x < x1; x++) {
    const offset = (y * WIDTH + x) * 3;
    value += (hdr[offset]! + hdr[offset + 1]! + hdr[offset + 2]!) / 3; count++;
  }
  return value / count;
};
export async function runSpecularMaterialGpuProbe() {
  const constrainedGpu = new Proxy(navigator.gpu, { get(target, key) {
    if (key === "requestAdapter") return async (options: GPURequestAdapterOptions) => {
      const adapter = await target.requestAdapter(options);
      if (!adapter) return null;
      return new Proxy(adapter, { get(owner, field) {
        if (field === "limits") return new Proxy(owner.limits, { get(limits, name) {
          return name === "maxSampledTexturesPerShaderStage" ? 16 : Reflect.get(limits, name, limits);
        } });
        if (field === "requestDevice") return (descriptor: GPUDeviceDescriptor) => {
          if (descriptor.requiredLimits?.maxSampledTexturesPerShaderStage !== 16) throw Error("Probe requires an actual 16-slot device request");
          return owner.requestDevice(descriptor);
        };
        const value = Reflect.get(owner, field, owner); return typeof value === "function" ? value.bind(owner) : value;
      } });
    };
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  const canvas = document.createElement("canvas"); document.querySelector("#canvases")!.append(canvas);
  canvas.style.width = "640px"; canvas.style.height = "384px";
  const renderer = await bounded(PbrRenderer.create(canvas, constrainedGpu, new AbortController().signal, {
    advancedMaterials: true, deformation: true, msaaSampleCount: 4,
    pipelines: { firstFrameMainKeys: ["plain/depth/double", "material/depth/double"] },
    frameCapture: { session: new FrameCaptureSession(), readbacks: { requests: [{ resourceId: "present-color" }] } },
    shadows: { exactProfile: { cascadeCount: 1, shadowMapSize: 128 } },
    features: { environment: false, fog: false, groundPlane: false, groundGrid: false, ambientOcclusion: false,
      screenSpaceReflection: false, volumetricFog: false, temporalAa: false, spatialAa: false,
      occlusionCulling: false, bloom: false, vignette: false, contactShadows: false },
  }));
  const view: RenderView = { width: WIDTH, height: HEIGHT, pixelRatio: 1, eye: [0, 0, 3], target: [0, 0, 0],
    extent: 4, background: [0, 0, 0], floor: [0, 0, 0], exposure: 1, roughness: .3, environmentIntensity: 0,
    fog: null, near: .1, far: 30, verticalFovRadians: Math.PI / 4,
    lights: { directional: [{ directionWorld: [0, 0, -1], color: [1, 1, 1], intensity: 1, castShadow: false },
      { directionWorld: [0, 0, 1], color: [1, 1, 1], intensity: 1, castShadow: false }], ambient: [] } };
  const results = [];
  try {
    for (const [name, fields, semantic] of [
      ["emissive-control", { emissiveFactor: [.1,.1,.1] }, "specularColor"],
      ["stock", {}, "specularColor"], ["zero-factor", { specularFactor: 0 }, "specularColor"],
      ["color-mask", { specularColorTexture: slot }, "specularColor"],
      ["alpha-mask", { specularTexture: slot }, "specular"],
      ["uv1-mask", { specularColorTexture: { ...slot, texCoord: 1 } }, "specularColor"],
      ["metal-stock", { metallic: 1, baseColor: [.2, .5, .8] }, "specularColor"],
      ["metal-mask", { metallic: 1, baseColor: [.2, .5, .8], specularColorTexture: slot }, "specularColor"],
      ["deformed-color-mask", { specularColorTexture: slot }, "specularColor"],
    ] as const) {
      const source = packet(fields, semantic);
      await bounded(renderer.setPacketValidated(name.startsWith("deformed") ? deformed(source) : source));
      const metrics = await bounded(renderer.validateFrame(view)); renderer.render(view);
      const image = await readSharedDeepFrame(renderer, WIDTH, HEIGHT);
      if (!image.hdr.every(Number.isFinite) || !metrics) throw Error(`Invalid real frame: ${name}`);
      results.push({ name, left: mean(image.hdr, 48, 68), right: mean(image.hdr, 92, 112),
        max: Math.max(...image.hdr), drawCalls: metrics.drawCalls });
    }
    const [control, stock, zero, color, alpha, uv1, metal, metalMask, deform] = results;
    const tests = { emissiveControl: control!.left > .05, stockVisible: stock!.left > .001, zeroStrength: zero!.left < stock!.left * .01,
      colorMask: color!.left < color!.right * .1, alphaMask: alpha!.left < alpha!.right * .01,
      uv1: uv1!.right < uv1!.left * .1,
      deformation: deform!.right > .001 && deform!.left < deform!.right * .1,
      metalInvariant: Math.abs(metal!.left - metalMask!.left) < .0001 && Math.abs(metal!.right - metalMask!.right) < .0001 };
    const sampledTextureLimit = renderer.session.device.limits.maxSampledTexturesPerShaderStage;
    return { passed: sampledTextureLimit === 16 && Object.values(tests).every(Boolean) && renderer.deviceDiagnostics.length === 0,
      sampledTextureLimit, tests, results, diagnostics: renderer.deviceDiagnostics, width: WIDTH, height: HEIGHT };
  } finally { renderer.dispose(); }
}
document.querySelector<HTMLButtonElement>("#run")?.addEventListener("click", async event => {
  (event.currentTarget as HTMLButtonElement).disabled = true;
  let result;
  try { result = await runSpecularMaterialGpuProbe(); }
  catch (error) { result = { passed: false, error: String(error), stack: error instanceof Error ? error.stack : undefined }; }
  document.querySelector("#result")!.textContent = JSON.stringify(result, null, 2);
  await fetch("/result", { method: "POST", body: JSON.stringify(result) });
});
