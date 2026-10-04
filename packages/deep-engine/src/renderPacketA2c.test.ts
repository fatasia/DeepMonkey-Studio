import { describe, expect, it, vi } from "vitest";
import { packInstanceBatches } from "./renderPacketBatches.js";
import { projectMaterial } from "./threeBridge/materials.js";
import type { PbrMaterial, PreparedBatch, RenderInstance } from "./renderPacketTypes.js";
import { compileMaterialEffectLedger } from "./webgpu/materialEffectLedger.js";
import { drawPacketBatches } from "./webgpu/packetDraw.js";
import type { CachedPacketBatch, CachedPacketGeometry } from "./webgpu/packetBufferTypes.js";
import { mainPipelineKey } from "./webgpu/pipelines.js";
import type { PacketCullingResources } from "./webgpu/packetCulling.js";

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const baseMaterial: PbrMaterial = { id: "m", baseColor: [0.5, 0.5, 0.5], metallic: 0, roughness: 0.5 };
function instance(id: string): RenderInstance { return { id, geometry: "g", material: "m", transform: identity }; }
function prepare(material: PbrMaterial, instances: readonly RenderInstance[]): readonly PreparedBatch[] {
  return packInstanceBatches(new Set(["g"]), instances, new Map([[material.id, material]]), new Map());
}

describe("alphaToCoverage batch contract (AA-M2)", () => {
  it("isolates a2c materials into their own batch and packs surface flag 512", () => {
    const a2c: PbrMaterial = { ...baseMaterial, alphaToCoverage: true };
    const plain: PbrMaterial = { ...baseMaterial, id: "plain" };
    const [batch] = prepare(a2c, [instance("i1")]);
    expect(batch.alphaToCoverage).toBe(true);
    expect(batch.key.endsWith("/a2c")).toBe(true);
    // instance 行 offset+31:surfaceFlags = 512(无其他语义位)。
    expect(batch.data[31]).toBe(512);
    // 同几何、同 alphaMode 的 a2c 与普通材质不得混批(管线状态不同)。
    const mixed = packInstanceBatches(new Set(["g"]),
      [{ id: "a", geometry: "g", material: a2c.id, transform: identity },
       { id: "b", geometry: "g", material: plain.id, transform: identity }],
      new Map([[a2c.id, a2c], [plain.id, plain]]), new Map());
    expect(mixed).toHaveLength(2);
    expect(mixed.map(value => value.key.endsWith("/a2c")).sort()).toEqual([false, true]);
  });

  it("coexists with MASK cutoff semantics (three r185 alphaTest + a2c)", () => {
    const masked: PbrMaterial = { ...baseMaterial, alphaToCoverage: true, alphaMode: "MASK", alphaCutoff: 0.4 };
    const [batch] = prepare(masked, [instance("i")]);
    expect(batch.alphaMode).toBe("MASK");
    expect(batch.alphaCutoff).toBe(0.4);
    expect(batch.data[31]).toBe(2 + 512);
  });

  it("rejects alphaToCoverage on BLEND batches (1x OIT has no multisample semantics)", () => {
    const blended: PbrMaterial = { ...baseMaterial, alphaToCoverage: true, alphaMode: "BLEND" };
    expect(() => prepare(blended, [instance("i")])).toThrow("alphaToCoverage with BLEND");
  });

  it("reconciles authored vs consumed a2c state in the material effect ledger", () => {
    const a2c: PbrMaterial = { ...baseMaterial, alphaToCoverage: true };
    const batches = prepare(a2c, [instance("i")]);
    const author = { materials: [a2c], instances: [{ id: "i", geometry: "g", material: "m",
      transform: identity, receiveShadow: true, castShadow: true }] };
    const ledger = compileMaterialEffectLedger(author, batches);
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]!.authored.surfaceFlags & 512).toBe(512);
    expect(ledger.entries[0]!.consumed.surfaceFlags & 512).toBe(512);
    expect(ledger.entries[0]!.authored.pipeline.alphaToCoverage).toBe(true);
    expect(ledger.entries[0]!.consumed.pipeline.alphaToCoverage).toBe(true);
  });
});

describe("a2c three projection bridge (AA-M2)", () => {
  const hooks = { materialBeforeRender: () => undefined, materialBeforeCompile: () => undefined,
    materialProgramCacheKey: () => undefined } as never;
  const textures = { projectBaseColor: () => undefined, projectMetallicRoughness: () => undefined,
    projectNormal: () => undefined, projectOcclusion: () => undefined, projectEmissive: () => undefined } as never;
  /** three r185 MeshStandardMaterial 的最小合法投影面(无贴图、无扩展)。 */
  function threeMaterial(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { type: "MeshStandardMaterial", isMeshStandardMaterial: true, isMeshPhysicalMaterial: false,
      onBeforeRender: hooks.materialBeforeRender, onBeforeCompile: hooks.materialBeforeCompile,
      customProgramCacheKey: hooks.materialProgramCacheKey, defines: { STANDARD: "" },
      color: { r: 0.5, g: 0.5, b: 0.5 }, emissive: { r: 0, g: 0, b: 0 },
      metalness: 0, roughness: 0.5, emissiveIntensity: 1, opacity: 1, alphaTest: 0,
      transparent: false, fog: true, blending: 1, premultipliedAlpha: false,
      side: 0, forceSinglePass: true, wireframe: false, depthTest: true, depthWrite: true,
      depthFunc: 3, colorWrite: true, stencilWrite: false, polygonOffset: false,
      toneMapped: true, dithering: false, clippingPlanes: [], shadowSide: null,
      aoMap: null, specularMap: null, alphaMap: null, lightMap: null, bumpMap: null,
      displacementMap: null, envMap: null, map: null, metalnessMap: null, roughnessMap: null,
      normalMap: null, aoMapIntensity: 1, normalMapType: 0, normalScale: { x: 1, y: 1 },
      emissiveMap: null, ...overrides };
  }

  it("fail-closed by default and projects the request only when the renderer declares MSAA capability", () => {
    expect(() => projectMaterial(threeMaterial({ alphaToCoverage: true }), "m1", hooks, textures))
      .toThrow("material alphaToCoverage");
    const projected = projectMaterial(threeMaterial({ alphaToCoverage: true }), "m1", hooks, textures, false, true);
    expect(projected.material.alphaToCoverage).toBe(true);
    // alphaTest=0 的 a2c:OPAQUE 档(纯 sample-mask 平滑,无 discard),阴影走实心 —— three 一致。
    expect(projected.material.alphaMode).toBeUndefined();
    expect(projected.depthWrite).toBe(true);
  });

  it("keeps alphaTest discard coexistence (MASK) and rejects the transparent combination", () => {
    const masked = projectMaterial(threeMaterial({ alphaToCoverage: true, alphaTest: 0.4 }), "m1", hooks, textures, false, true);
    expect(masked.material.alphaMode).toBe("MASK");
    expect(masked.material.alphaCutoff).toBe(0.4);
    expect(masked.material.alphaToCoverage).toBe(true);
    expect(() => projectMaterial(threeMaterial({ alphaToCoverage: true, transparent: true, depthWrite: false }),
      "m1", hooks, textures, false, true)).toThrow("alphaToCoverage with transparent");
  });

  it("treats non-boolean alphaToCoverage as invalid and keeps alphaHash fail-closed", () => {
    expect(() => projectMaterial(threeMaterial({ alphaToCoverage: "yes" }), "m1", hooks, textures, false, true))
      .toThrow("material.alphaToCoverage");
    expect(() => projectMaterial(threeMaterial({ alphaHash: true }), "m1", hooks, textures, false, true))
      .toThrow("material alphaHash");
  });
});
describe("a2c draw-time pipeline selection (AA-M2)", () => {
  const geometry: CachedPacketGeometry = { source: { id: "g", revision: 1, vertices: new Float32Array(18),
      indices: new Uint32Array([0, 1, 2]) }, mesh: { draw: vi.fn(), indexCount: 6 } as never,
    center: [0, 0, 0], radius: 1 };
  function cachedBatch(batch: PreparedBatch): CachedPacketBatch {
    return { source: batch, buffer: {} as GPUBuffer, capacity: 0, previousBuffer: {} as GPUBuffer,
      previousCapacity: 0, previousTransforms: new Float32Array(0) };
  }
  function fakePipelines(keys: readonly string[]) {
    const pipelines = new Map(keys.map(key => [key, { key } as unknown as GPURenderPipeline]));
    return { mainPipelines: pipelines, displayPipelines: pipelines,
      displayDirectionalPipelines: new Map(), shadowPipelines: new Map() } as never;
  }
  const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), draw: vi.fn() } as never;
  const emptyCulling = {} as PacketCullingResources;

  it("routes a2c batches to the /a2c main pipeline variant", () => {
    const a2c: PbrMaterial = { ...baseMaterial, alphaToCoverage: true };
    const [batch] = prepare(a2c, [instance("i")]);
    const key = mainPipelineKey("plain", false, "ccw", true);
    const result = drawPacketBatches(pass, fakePipelines([key, mainPipelineKey("plain", false, "ccw")]),
      "opaque", new Map([[batch.key, cachedBatch(batch)]]), new Map([["g", geometry]]), emptyCulling);
    expect(result.drawCalls).toBe(1);
    expect(pass.setPipeline).toHaveBeenCalledWith(expect.objectContaining({ key }));
  });

  it("fails closed with an actionable error when the set lacks the a2c variant (1x renderer)", () => {
    const a2c: PbrMaterial = { ...baseMaterial, alphaToCoverage: true };
    const [batch] = prepare(a2c, [instance("i")]);
    expect(() => drawPacketBatches(pass, fakePipelines([mainPipelineKey("plain", false, "ccw")]),
      "opaque", new Map([[batch.key, cachedBatch(batch)]]), new Map([["g", geometry]]), emptyCulling))
      .toThrow("alphaToCoverage requires the MSAA main-pass pipeline set");
  });

  it("falls back to the plain pipeline on the 1x direct-display path (a2c has no 1x semantics)", () => {
    const a2c: PbrMaterial = { ...baseMaterial, alphaToCoverage: true };
    const [batch] = prepare(a2c, [instance("i")]);
    const plainKey = mainPipelineKey("plain", false, "ccw");
    const result = drawPacketBatches(pass, fakePipelines([plainKey]), "display",
      new Map([[batch.key, cachedBatch(batch)]]), new Map([["g", geometry]]), emptyCulling,
      undefined, undefined, false, 0, false, false);
    expect(result.drawCalls).toBe(1);
    expect(pass.setPipeline).toHaveBeenCalledWith(expect.objectContaining({ key: plainKey }));
  });
});
