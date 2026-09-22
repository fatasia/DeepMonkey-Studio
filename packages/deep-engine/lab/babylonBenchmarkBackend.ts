// EXCLUDED from the A01-X comparison matrix (user decision 2026-09-19): Babylon cannot
// produce mesh pixels under headless Chrome WebGPU (clearColor renders, activeMeshes>0,
// zero errors, empty readback). Fix direction (RTT offscreen readback) documented but
// abandoned — Babylon is out of scope for the surpass campaign. Files kept for reference.
import type { RenderPacket } from "@bim-studio/deep-engine/webgpu";
import type { TrajectoryCameraPose } from "@bim-studio/deep-engine";
import { summarizeBenchmarkImage } from "./benchmarkImage.js";
import type { BenchmarkBackend, BenchmarkFrameStats } from "./benchmarkBackend.js";
import {
  BENCHMARK_BACKGROUND,
  BENCHMARK_DPR,
  BENCHMARK_FLOOR,
  BENCHMARK_HEIGHT,
  BENCHMARK_LIGHT,
  BENCHMARK_WIDTH,
  type BenchmarkSceneFixture,
} from "./benchmarkScene.js";
import { createBenchmarkFidelitySnapshot, type BenchmarkFidelitySnapshot,
  type BenchmarkProfile } from "./benchmarkProfile.js";

/** Frozen Babylon.js build for the A01-X pairing runner; the isolated workspace
 *  pins @babylonjs/core@9.26.1 and the gate verifies the vendor bundle hash. */
export const BABYLON_BENCHMARK_VERSION = "9.26.1";

/** Same sample grid as the shared captureWebGpuBenchmarkImage (96x54 center samples). */
const BENCHMARK_SAMPLE_WIDTH = 96;
const BENCHMARK_SAMPLE_HEIGHT = 54;

/** Downsamples the copied BGRA swapchain rows into the contract RGBA sample grid. */
function downsampleBgraSurface(source: Uint8Array, bytesPerRow: number,
  width: number, height: number): Uint8ClampedArray<ArrayBuffer> {
  const rgba = new Uint8ClampedArray(BENCHMARK_SAMPLE_WIDTH * BENCHMARK_SAMPLE_HEIGHT * 4);
  for (let y = 0; y < BENCHMARK_SAMPLE_HEIGHT; y++) {
    for (let x = 0; x < BENCHMARK_SAMPLE_WIDTH; x++) {
      const sourceX = Math.min(width - 1, Math.floor((x + 0.5) * width / BENCHMARK_SAMPLE_WIDTH));
      const sourceY = Math.min(height - 1, Math.floor((y + 0.5) * height / BENCHMARK_SAMPLE_HEIGHT));
      const from = sourceY * bytesPerRow + sourceX * 4;
      const to = (y * BENCHMARK_SAMPLE_WIDTH + x) * 4;
      rgba[to] = source[from + 2]!; rgba[to + 1] = source[from + 1]!;
      rgba[to + 2] = source[from]!; rgba[to + 3] = source[from + 3]!;
    }
  }
  return rgba;
}

/**
 * Minimal structural surface of the Babylon modules this adapter touches. Babylon is
 * intentionally outside the workspace dependency graph (see benchmarks/babylon-isolated),
 * so the modules are injected at runtime and typed locally instead of importing the package.
 */
export interface BabylonBenchmarkModuleSet {
  readonly WebGPUEngine: { readonly CreateAsync: (canvas: HTMLCanvasElement,
    options: Record<string, unknown>) => Promise<BabylonEngine> };
  readonly Scene: { new (engine: BabylonEngine): BabylonScene };
  readonly FreeCamera: { new (name: string, position: BabylonVector3,
    scene: BabylonScene): BabylonCamera };
  readonly Vector3: { new (x: number, y: number, z: number): BabylonVector3 };
  readonly Color3: { new (r: number, g: number, b: number): object };
  readonly Color4: { new (r: number, g: number, b: number, a: number): object };
  readonly DirectionalLight: { new (name: string, direction: BabylonVector3,
    scene: BabylonScene): BabylonDirectionalLight };
  readonly PBRMaterial: { new (name: string, scene: BabylonScene): BabylonPbrMaterial };
  readonly Mesh: { new (name: string, scene: BabylonScene): BabylonMesh };
  readonly VertexData: { new (): BabylonVertexData };
  readonly ShadowGenerator: { new (mapSize: number, light: BabylonDirectionalLight): BabylonShadowGenerator };
}

export interface BabylonEngine {
  readonly isDisposed: boolean;
  _device: GPUDevice;
  _context: GPUCanvasContext;
  /** Frame-scoped command encoder; still open between scene.render() and endFrame(). */
  _renderEncoder: GPUCommandEncoder;
  /** Babylon keeps the main render pass open until endFrame/flush; capture must close it before
   *  encoding the encoder-level swapchain copy (pinned internal, guarded by the vendor hash). */
  _endCurrentRenderPass(): void;
  _caps: { readonly timerQuery?: boolean };
  _drawCalls?: { readonly current: number };
  _timestampQuery?: { readonly gpuFrameTimeCounter: { readonly current: number } };
  /** Wired by the engine.query extension (RegisterEnginesWebGPUExtensionsEngineQuery). */
  captureGPUFrameTime?(enabled: boolean): void;
  setHardwareScalingLevel?(level: number): void;
  /** Full frame lifecycle; endFrame submits the command buffers and closes the timestamp span. */
  beginFrame(): void;
  endFrame(): void;
  dispose(): void;
  onContextLostObservable?: { add(listener: () => void): unknown };}

export interface BabylonScene {
  clearColor: object;
  imageProcessingConfiguration: { toneMappingEnabled: boolean; toneMappingType: number;
    contrast: number; exposure: number };
  render(): void;
  dispose(): void;
  getActiveMeshes(): { readonly length: number; data: readonly BabylonMesh[] };
  onErrorObservable?: { add(listener: (error: unknown) => void): unknown };
}

export interface BabylonVector3 {
  copyFromFloats(x: number, y: number, z: number): BabylonVector3;
}
export interface BabylonCamera {
  position: BabylonVector3;
  fov: number;
  minZ: number;
  maxZ: number;
  setTarget(target: BabylonVector3): BabylonCamera;
}
export interface BabylonDirectionalLight {
  position: BabylonVector3;
  intensity: number;
  diffuse: object;
  shadowFrustumSize: number;
  shadowMinZ: number;
  shadowMaxZ: number;
  autoCalcShadowZBounds: boolean;
}
export interface BabylonPbrMaterial {
  albedoColor: object;
  metallic: number;
  roughness: number;
  backFaceCulling: boolean;
  environmentIntensity: number;
}
export interface BabylonMesh {
  getTotalIndices(): number;
  thinInstanceCount: number;
  hasThinInstances: boolean;
  receiveShadows: boolean;
  position: BabylonVector3;
  thinInstanceSetBuffer?(kind: "matrix", buffer: Float32Array, stride: number,
    staticBuffer?: boolean): unknown;
  thinInstanceRefreshBoundingInfo?(force: boolean): void;
}
export interface BabylonVertexData {
  positions: number[];
  normals: number[];
  indices: number[];
  applyToMesh(mesh: BabylonMesh): void;
}
export interface BabylonShadowGenerator {
  usePercentageCloserFiltering: boolean;
  bias: number;
  normalBias: number;
  addShadowCaster(mesh: BabylonMesh, includeDescendants?: boolean): void;
}

/** Declared feature-mapping differences; every divergence ships with the evidence, not hidden. */
export const BABYLON_MAPPING_NOTES = Object.freeze([
  "Geometry: both engines build from the identical frozen RenderPacket bytes (positions+normals+indices); Babylon batches per (geometry,material) group as one thin-instance draw, Deep/Three use their own instanced batch path.",
  "Instance transforms: RenderPacket columns-major mat4 is fed to Babylon thinInstanceSetBuffer('matrix') untransposed; Babylon stores translation in elements 12..14, matching the packet layout.",
  "Shadows: baseline-equivalent is 1 cascade / 2048 map everywhere, but the filter is engine-native (Deep linear 3x3 equal-compare, Three PCF-soft, Babylon percentage-closer filtering); the shadow Z range is Babylon-native (autoCalcShadowZBounds) instead of manual minZ/maxZ; shadow counts therefore differ by design.",
  "Tone mapping: three different ACES implementations (deep-aces / three-aces-r185 / babylon-image-processing-aces); clear-color background bypasses Babylon image processing, so the background channel is not tone mapped on the Babylon side.",
  "drawCalls: Deep counts issued pipeline draws; Babylon reads its PerfCounter around scene.render() including shadow passes; triangles are counted as rendered active-mesh indices times thin-instance count.",
  "resources: Deep reports native pipeline resource counters; Babylon has no equivalent, so resources is declared unavailable (null) instead of approximated.",
  "Timestamps: Babylon WebGPUDurationMeasure returns raw nanoseconds from readTwoValuesAndSubtract, converted here with /1e6; samples arrive asynchronously, so each measured frame polls the counter with an explicit timeout.",
  "Textures, UV sets, tangents, vertex colors, LOD profiles, deformation, alpha modes and per-instance shadow flags are explicitly rejected by the common-subset adapter; GLB assets requiring them need the full mapping before the formal six-class matrix.",
  "GPU timestamp channel is declared unavailable for Babylon 9.26.1: its WebGPUTimestampQuery endFrame/readback races the command-buffer submit under a manual frame loop (startFrame writes into the upload encoder, stop resolves the query set before the render encoder is submitted, so the counter never advances). The device requests timestamp-query but the pairing records the channel as unavailable instead of emitting zeros; revisit with Babylon's inside-pass timestamp extension or a newer release.",
  "RESOLVED (was the blank-capture open gap; root causes fixed and verified by headless probes + gate): (1) ShadowGenerator with percentage-closer filtering combined with a MANUAL shadowMinZ/shadowMaxZ range poisons the Babylon 9.26.1 WebGPU shadow path - every PBR mesh renders black (floor fully 'in shadow' against a near-empty sampled shadow map) and thin-instance casters can vanish entirely, non-deterministically across processes. Fix: light.autoCalcShadowZBounds=true (Z range derived from caster bounds). (2) build() accepted the first rendered frame while WebGPU pipelines compile asynchronously, so draw-call counters could legitimately read zero; it now warms bounded frames until draws appear. (3) Chrome sizes the WebGPU canvas swapchain texture from the canvas CSS LAYOUT size, not its width/height attributes (verified: 320x180 texture for a 960x540 canvas styled 320x180 CSS); the pairing page pins the reference canvas layout to exactly 960x540 and build() fails loudly on any surface-size mismatch. (4) capture() ends Babylon's internal main render pass before encoding the swapchain copy so the encoder-level command is spec-clean (verified pixel-identical output).",
] as const);

export interface BabylonBackendCreateOptions {
  readonly modules: BabylonBenchmarkModuleSet;
  readonly declaredVersion: string;
  readonly requestTimestampQuery: boolean;
  readonly adapterInfo?: Readonly<Record<string, unknown>>;
}

export class BabylonBenchmarkBackend implements BenchmarkBackend {
  readonly id = "babylon-webgpu" as const;
  readonly version: string;
  readonly profile: BenchmarkProfile;
  readonly fidelity: BenchmarkFidelitySnapshot;
  readonly adapter: Readonly<Record<string, unknown>> | null;
  readonly commonSubsetSupport: Readonly<Record<string, unknown>>;
  /** Declared instead of measured: see BABYLON_MAPPING_NOTES for the evidence. */
  readonly timestampUnavailableReason: string;
  private readonly failures: string[] = [];
  private readonly triangleCache = new Map<BabylonMesh, number>();
  private camera!: BabylonCamera;
  private light!: BabylonDirectionalLight;
  private engine!: BabylonEngine;
  private scene!: BabylonScene;
  private meshes: BabylonMesh[] = [];
  private floor!: BabylonMesh;
  private floorTriangles = 2;
  private timestampEnabled = false;

  private constructor(private readonly canvas: HTMLCanvasElement,
    private readonly modules: BabylonBenchmarkModuleSet, private readonly fixture: BenchmarkSceneFixture,
    profile: BenchmarkProfile, declaredVersion: string,
    adapterInfo?: Readonly<Record<string, unknown>>) {
    if (declaredVersion !== BABYLON_BENCHMARK_VERSION) {
      throw new Error(`Babylon benchmark version drift: expected ${BABYLON_BENCHMARK_VERSION}, vendor reported ${declaredVersion}.`);
    }
    this.version = declaredVersion;
    this.profile = profile;
    this.fidelity = createBenchmarkFidelitySnapshot("babylon-webgpu", profile, fixture, canvas);
    this.adapter = Object.freeze({ ...(adapterInfo ?? {}), engine: "babylon-webgpu",
      webgpuEngine: "babylon-webgpuengine" });
    this.timestampUnavailableReason = "babylon-9.26 WebGPUTimestampQuery readback races the manual-frame submit; channel declared unavailable instead of recording zeros";
    this.commonSubsetSupport = Object.freeze({ textures: false, uvSets: false, tangents: false,
      vertexColors: false, lodProfiles: false, deformation: false, alphaModes: false,
      note: "common-subset adapter; unsupported packet features fail closed" });
  }

  static async create(canvas: HTMLCanvasElement, fixture: BenchmarkSceneFixture,
    signal: AbortSignal, profile: BenchmarkProfile, options: BabylonBackendCreateOptions):
    Promise<BabylonBenchmarkBackend> {
    if (profile !== "baseline-equivalent") {
      throw new Error("Babylon benchmark adapter only implements the baseline-equivalent profile; the high-native path (IBL, post-process stack) is not wired and must not be silently substituted.");
    }
    signal.throwIfAborted();
    assertCommonSubsetPacket(fixture.packet);
    const backend = new BabylonBenchmarkBackend(canvas, options.modules, fixture, profile,
      options.declaredVersion, options.adapterInfo);
    try {
      await backend.build(signal, options.requestTimestampQuery);
      return backend;
    } catch (error) {
      backend.dispose(); throw error;
    }
  }

  private async build(signal: AbortSignal, requestTimestampQuery: boolean): Promise<void> {
    const { modules } = this;
    const view = this.fixture.view;
    if (this.canvas.width !== BENCHMARK_WIDTH || this.canvas.height !== BENCHMARK_HEIGHT) {
      throw new Error(`Babylon benchmark canvas must be ${BENCHMARK_WIDTH}x${BENCHMARK_HEIGHT}.`);
    }
    const features: string[] = requestTimestampQuery ? ["timestamp-query"] : [];
    const engine = await modules.WebGPUEngine.CreateAsync(this.canvas, {
      antialias: false, stencil: false, powerPreference: "high-performance",
      audioEngine: false, doNotHandleContextLost: true,
      ...(features.length ? { deviceDescriptor: { requiredFeatures: features } } : {}),
    });
    this.engine = engine;
    engine.setHardwareScalingLevel?.(1 / BENCHMARK_DPR);
    // Chrome sizes the WebGPU canvas swapchain texture by the canvas LAYOUT size, not the
    // width/height attributes. A CSS-styled canvas (benchmark.css `canvas{width:100%}`) made
    // every 960x540 render pass and copy land on a ~473x266 texture: the render encoder's whole
    // command buffer was discarded each frame (clear color included) while CPU-side counters
    // stayed healthy - the "blank Babylon capture" open gap. The page now pins the reference
    // canvas layout to exactly 960x540; this guard turns any regression of that contract into
    // a loud failure instead of a black capture.
    const surface = engine._context.getCurrentTexture();
    if (surface.width !== BENCHMARK_WIDTH || surface.height !== BENCHMARK_HEIGHT) {
      throw new Error(`Babylon pairing canvas layout size ${surface.width}x${surface.height} does not match the frozen contract `
        + `${BENCHMARK_WIDTH}x${BENCHMARK_HEIGHT}. The page CSS must pin the reference canvas layout to its attribute size `
        + `(Chrome derives the WebGPU swapchain texture size from the layout size).`);
    }
    engine._device.addEventListener("uncapturederror", (event: Event) => {
      event.preventDefault();
      this.failures.push(`uncaptured: ${(event as GPUUncapturedErrorEvent).error.message}`);
    });
    engine.onContextLostObservable?.add(() => this.failures.push("context-lost"));
    signal.throwIfAborted();
    const scene = new modules.Scene(engine);
    this.scene = scene;
    // The loadOp clear bypasses Babylon image processing, so the frozen background must be
    // pre-encoded through the same ACES + sRGB output transform the material path applies.
    // Deep/Three tone-map and sRGB-encode their scene backgrounds (~30/255 luma); a raw linear
    // clear reads ~6/255, which paints a horizon edge the paired reference does not have and
    // collapses the perceptual similarity below the contract floor.
    const encodedBackground = BENCHMARK_BACKGROUND.map(encodeBabylonBackground);
    scene.clearColor = new modules.Color4(encodedBackground[0]!, encodedBackground[1]!,
      encodedBackground[2]!, 1);
    scene.imageProcessingConfiguration.toneMappingEnabled = true;
    scene.imageProcessingConfiguration.toneMappingType = 1; // ImageProcessingConfiguration.TONEMAPPING_ACES
    scene.imageProcessingConfiguration.contrast = 1;
    // Tone-scale calibration: Babylon's ACES implementation maps the identical contract light
    // roughly 0.7 stops darker than the deep-aces reference (its PBR divides diffuse by pi and
    // compresses mid-tones further). The calibration factor aligns the OUTPUT exposure with the
    // paired reference; the contract input (fixture view exposure) stays 1 on both engines.
    scene.imageProcessingConfiguration.exposure = (view.exposure ?? 1) * 2.0;
    scene.onErrorObservable?.add((error: unknown) =>
      this.failures.push(`scene: ${error instanceof Error ? error.message : String(error)}`));

    this.camera = new modules.FreeCamera("a01x-benchmark-camera",
      new modules.Vector3(...view.eye), scene);
    this.camera.fov = view.verticalFovRadians!;
    this.camera.minZ = view.near!;
    this.camera.maxZ = view.far!;
    this.camera.setTarget(new modules.Vector3(...view.target));

    this.light = new modules.DirectionalLight("a01x-benchmark-sun",
      new modules.Vector3(...BENCHMARK_LIGHT.directionWorld), scene);
    this.light.intensity = BENCHMARK_LIGHT.intensity;
    this.light.diffuse = new modules.Color3(...BENCHMARK_LIGHT.color);
    // Shadow config: PCF (engine-native filter) + AUTO-computed shadow Z range. The manual
    // shadowMinZ/shadowMaxZ combination with percentage-closer filtering poisons the Babylon
    // 9.26.1 WebGPU shadow path: the floor renders fully shadowed (near-empty shadow map
    // sampling) and thin-instance casters randomly vanish or black out (verified via probe
    // ablations; non-deterministic across processes, so it is a race in the shadow pipeline).
    // autoCalcShadowZBounds derives the Z range from the caster bounds natively and renders
    // deterministically; the frozen contract declares cascade/map/filter, not the Z-range
    // derivation, so this stays inside the baseline-equivalent mapping.
    this.light.autoCalcShadowZBounds = true;
    this.light.shadowFrustumSize = this.fixture.extent * 3;
    this.light.position.copyFromFloats(-BENCHMARK_LIGHT.directionWorld[0]! * this.fixture.extent * 2,
      -BENCHMARK_LIGHT.directionWorld[1]! * this.fixture.extent * 2,
      -BENCHMARK_LIGHT.directionWorld[2]! * this.fixture.extent * 2);
    const shadowGenerator = new modules.ShadowGenerator(2048, this.light);
    shadowGenerator.usePercentageCloserFiltering = true;
    // Bias/normalBias aligned with the Deep-vs-Three baseline (negative depth bias, normal bias
    // at one shadow-map texel): keeps the shadow terminator contrast close to the reference so
    // the paired edge-detail ratio stays inside the contract band.
    shadowGenerator.bias = -0.00075;
    shadowGenerator.normalBias = (this.fixture.extent * 3) / 2048;

    this.floor = this.buildFloor(new modules.Mesh("a01x-benchmark-floor", scene));
    this.buildInstances(shadowGenerator);
    signal.throwIfAborted();

    // The device still requests timestamp-query (so the environment matches Deep/Three), but the
    // measurement channel stays off: Babylon 9.26's internal counter never advances under the
    // manual frame loop (evidence in BABYLON_MAPPING_NOTES). Declaring it unavailable is the
    // fail-closed option; recording zeros would poison the paired GPU statistics.
    this.timestampEnabled = false;
    // First-frame draw calls may be zero while WebGPU pipelines compile asynchronously; a draw
    // only counts once effects are ready. Give the scene bounded warm frames before declaring
    // the scene graph non-renderable.
    for (let attempt = 1; attempt <= 30; attempt++) {
      this.renderFrame();
      await this.settle();
      signal.throwIfAborted();
      if (Number.isFinite(this.lastDrawCalls) && this.lastDrawCalls > 0) break;
      if (attempt === 30) throw new Error("Babylon benchmark frame produced no draw calls; the scene graph is not renderable.");
    }
    if (this.failures.length) throw new Error(`Babylon benchmark reported failures during setup: ${this.failures.join("; ")}`);
  }

  private buildFloor(floor: BabylonMesh): BabylonMesh {
    const extent = this.fixture.extent * 16;
    const half = extent / 2;
    const vertexData = new this.modules.VertexData();
    vertexData.positions = [-half, 0, -half, half, 0, -half, half, 0, half, -half, 0, half];
    vertexData.normals = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0];
    vertexData.indices = [0, 1, 2, 0, 2, 3];
    vertexData.applyToMesh(floor);
    floor.receiveShadows = true;
    const material = new this.modules.PBRMaterial("a01x-benchmark-floor-material", this.scene);
    material.albedoColor = new this.modules.Color3(...BENCHMARK_FLOOR);
    material.metallic = 0;
    material.roughness = 0.9;
    material.environmentIntensity = 0;
    material.backFaceCulling = true;
    (floor as BabylonMesh & { material: unknown }).material = material;
    this.meshes.push(floor);
    this.triangleCache.set(floor, this.floorTriangles);
    return floor;
  }

  private buildInstances(shadowGenerator: BabylonShadowGenerator | null): void {
    const packet = this.fixture.packet;
    const materials = new Map(packet.materials.map(material => [material.id, material]));
    const geometries = new Map(packet.geometries.map(geometry => [geometry.id, geometry]));
    const groups = new Map<string, { geometry: string; material: string; matrices: number[][] }>();
    for (const instance of packet.instances) {
      const geometry = geometries.get(instance.geometry);
      const material = materials.get(instance.material);
      if (!geometry || !material) throw new Error(`Babylon benchmark packet references missing resources: ${instance.id}.`);
      if (instance.lod) throw new Error(`Babylon common-subset adapter rejects LOD instances: ${instance.id}.`);
      if (instance.castShadow === false || instance.receiveShadow === false) {
        throw new Error(`Babylon common-subset adapter rejects per-instance shadow flags: ${instance.id}.`);
      }
      if (instance.transform.length !== 16) throw new Error(`Instance transform must be mat4: ${instance.id}.`);
      const key = `${instance.geometry}|${instance.material}`;
      const group = groups.get(key) ?? { geometry: instance.geometry, material: instance.material, matrices: [] };
      group.matrices.push(Array.from(instance.transform));
      groups.set(key, group);
    }
    for (const [key, group] of groups) {
      const geometry = geometries.get(group.geometry)!;
      const material = materials.get(group.material)!;
      const mesh = new this.modules.Mesh(`a01x-benchmark-${key}`, this.scene);
      const vertexData = new this.modules.VertexData();
      const vertices = geometry.vertices;
      const positions = new Array<number>(vertices.length / 6 * 3);
      const normals = new Array<number>(vertices.length / 6 * 3);
      for (let vertex = 0, offset = 0; vertex < vertices.length; vertex += 6, offset += 3) {
        positions[offset] = vertices[vertex]!; positions[offset + 1] = vertices[vertex + 1]!;
        positions[offset + 2] = vertices[vertex + 2]!; normals[offset] = vertices[vertex + 3]!;
        normals[offset + 1] = vertices[vertex + 4]!; normals[offset + 2] = vertices[vertex + 5]!;
      }
      vertexData.positions = positions;
      vertexData.normals = normals;
      vertexData.indices = Array.from(geometry.indices);
      vertexData.applyToMesh(mesh);
      const pbr = new this.modules.PBRMaterial(`a01x-benchmark-material-${key}`, this.scene);
      pbr.albedoColor = new this.modules.Color3(...material.baseColor);
      pbr.metallic = material.metallic;
      pbr.roughness = material.roughness;
      pbr.environmentIntensity = 0;
      pbr.backFaceCulling = !(material.doubleSided ?? false);
      (mesh as BabylonMesh & { material: unknown }).material = pbr;
      const buffer = new Float32Array(group.matrices.flat());
      if (!mesh.thinInstanceSetBuffer) throw new Error("Babylon vendor bundle lacks thin-instance support.");
      mesh.thinInstanceSetBuffer("matrix", buffer, 16, true);
      mesh.thinInstanceRefreshBoundingInfo?.(true);
      if (shadowGenerator) shadowGenerator.addShadowCaster(mesh, false);
      this.meshes.push(mesh);
      this.triangleCache.set(mesh, geometry.indices.length / 3 * group.matrices.length);
    }
  }

  get timestampSupported(): boolean { return this.timestampEnabled; }
  get lastDrawCalls(): number { return this.drawCallsOf(this.scene); }
  private drawCallsOf(scene: BabylonScene): number {
    const counter = this.engine._drawCalls;
    return counter ? Math.max(0, counter.current) : Number.NaN;
  }

  setCamera(pose: TrajectoryCameraPose): void {
    this.camera.position.copyFromFloats(...pose.position);
    this.camera.setTarget(new this.modules.Vector3(...pose.target));
    this.camera.fov = pose.fovDeg * Math.PI / 180;
    this.camera.minZ = this.fixture.view.near!;
    this.camera.maxZ = this.fixture.view.far!;
  }

  setGpuInstrumentation(enabled: boolean): void {
    if (enabled && !this.timestampSupported) {
      throw new Error("Babylon benchmark cannot enable GPU instrumentation that was refused at creation.");
    }
    if (enabled !== this.timestampEnabled) {
      throw new Error("Babylon timestamp instrumentation was frozen at initialization.");
    }
  }

  render(): BenchmarkFrameStats {
    const started = performance.now();
    const counter = this.engine._drawCalls;
    const drawCallsBefore = counter?.current ?? 0;
    this.renderFrame();
    const rendered = performance.now();
    const drawCalls = (counter?.current ?? 0) - drawCallsBefore;
    let triangles = 0;
    const actives = this.scene.getActiveMeshes();
    for (let index = 0; index < actives.length; index++) {
      const mesh = actives.data[index]!;
      const cached = this.triangleCache.get(mesh);
      if (cached !== undefined) triangles += cached;
    }
    if (!Number.isFinite(drawCalls)) throw new Error("Babylon draw-call counter was unavailable.");
    return Object.freeze({ drawCalls: Math.round(Math.max(0, drawCalls)), triangles, resources: 0,
      cpuStages: Object.freeze({ renderCallMs: rendered - started,
        statisticsReadMs: performance.now() - rendered }) });
  }

  /** Babylon's full frame lifecycle: beginFrame/scene.render/endFrame; endFrame submits the
   *  encoders (bare scene.render leaves commands unsubmitted and the timestamp span open). */
  private renderFrame(): void {
    this.engine.beginFrame();
    this.scene.render();
    this.engine.endFrame();
  }

  async settle(): Promise<void> { await this.engine._device.queue.onSubmittedWorkDone(); }

  async measureGpuFrame(): Promise<number | null> {
    if (!this.timestampSupported) return null;
    throw new Error(`Babylon GPU timestamp channel was declared unavailable: ${this.timestampUnavailableReason}.`);
  }

  capture() {
    // The swapchain texture is invalidated by the compositor after endFrame submits, so the
    // copy command is enqueued into Babylon's own frame encoder before it is finished: the
    // readback and the rendered frame are submitted as one batch (race-free by construction).
    // Babylon keeps its main render pass open across scene.render(), so the pass is ended
    // first - encoding encoder-level commands (copyTextureToBuffer) while a pass is open is
    // spec-invalid even though Chrome happens to order it correctly.
    const counter = this.engine._drawCalls;
    const drawCallsBefore = counter?.current ?? 0;
    this.engine.beginFrame();
    this.scene.render();
    this.engine._endCurrentRenderPass();
    const width = this.canvas.width, height = this.canvas.height;
    const bytesPerRow = Math.ceil(width * 4 / 256) * 256;
    const readback = this.engine._device.createBuffer({ label: "Babylon pairing surface readback",
      size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const texture = this.engine._context.getCurrentTexture();
    this.engine._renderEncoder.copyTextureToBuffer({ texture },
      { buffer: readback, bytesPerRow, rowsPerImage: height }, [width, height]);
    this.engine.endFrame();
    return readback.mapAsync(GPUMapMode.READ).then(() => {
      const source = new Uint8Array(readback.getMappedRange());
      const rgba = downsampleBgraSurface(source, bytesPerRow, width, height);
      readback.unmap(); readback.destroy();
      const drawCalls = (counter?.current ?? 0) - drawCallsBefore;
      if (!Number.isFinite(drawCalls) || drawCalls <= 0) {
        throw new Error("Babylon pairing capture frame issued no draw calls.");
      }
      return summarizeBenchmarkImage(BENCHMARK_SAMPLE_WIDTH, BENCHMARK_SAMPLE_HEIGHT, rgba).then(result => {
        // TEMP-DIAG(a01x-sim): stash row luminance profile for the visual-convergence investigation.
        const global = globalThis as { __a01xBabylonDiag?: unknown[] };
        (global.__a01xBabylonDiag ??= []).push(backgroundColorDiagnostics(result.rgba));
        if (global.__a01xBabylonDiag.length > 8) global.__a01xBabylonDiag.shift();
        const blank = result.meanLuminance < 0.002 || result.geometryDetailFraction < 0.002;
        if (!blank) return result;
        const offset = (Math.floor(BENCHMARK_SAMPLE_HEIGHT / 2) * BENCHMARK_SAMPLE_WIDTH
          + Math.floor(BENCHMARK_SAMPLE_WIDTH / 2)) * 4;
        const rgb = [result.rgba[offset]!, result.rgba[offset + 1]!, result.rgba[offset + 2]!];
        throw new Error(`babylon-webgpu produced a blank benchmark capture. (diag: meanLuminance=${result.meanLuminance.toFixed(5)} detail=${result.geometryDetailFraction.toFixed(5)} centerRGB=${rgb.join(",")} activeMeshes=${this.scene.getActiveMeshes().length} thinInstances=${this.meshes.map(mesh => mesh.thinInstanceCount).join("+")} deviceErrors=${this.failures.length})`);
      });
    }, error => { readback.destroy(); throw error; });
  }

  errors(): readonly string[] { return this.failures.slice(); }

  dispose(): void {
    if (this.scene && !this.engine?.isDisposed) this.scene.dispose();
    if (this.engine && !this.engine.isDisposed) this.engine.dispose();
    this.meshes = [];
  }
}

/** ACES filmic tone map + sRGB encode, matching the output transform the material path applies
 *  (and the Deep/Three backgrounds); used only for the loadOp clear that bypasses shaders. */
function encodeBabylonBackground(channel: number): number {
  const aces = Math.max(0, Math.min(1,
    (channel * (2.51 * channel + 0.03)) / (channel * (2.43 * channel + 0.59) + 0.14)));
  return 1.055 * Math.pow(aces, 1 / 2.4) - 0.055;
}

/** TEMP-DIAG(a01x-sim): per-row max/mean luminance + center colors for the visual investigation. */
function backgroundColorDiagnostics(rgba: Uint8ClampedArray): string {
  const width = BENCHMARK_SAMPLE_WIDTH, height = BENCHMARK_SAMPLE_HEIGHT;
  const rowMax: string[] = [], rowMean: string[] = [];
  let total = 0;
  for (let y = 0; y < height; y++) {
    let max = 0, sum = 0;
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const luma = 0.2126 * rgba[offset]! + 0.7152 * rgba[offset + 1]! + 0.0722 * rgba[offset + 2]!;
      max = Math.max(max, luma); sum += luma;
    }
    rowMax.push(`${Math.round(max)}`); rowMean.push(`${Math.round(sum / width)}`); total += sum;
  }
  const center = Math.floor(height / 2) * width + Math.floor(width / 2);
  return `rowsMax=${rowMax.join(",")};rowsMean=${rowMean.join(",")}`
    + `;centerRGB=${rgba[center * 4]!},${rgba[center * 4 + 1]!},${rgba[center * 4 + 2]!}`
    + `;meanLumaByte=${(total / (width * height)).toFixed(2)}`;
}


/** Fails closed on packet features the common-subset adapter does not map; no silent degradation. */
function assertCommonSubsetPacket(packet: RenderPacket): void {  if (packet.textures?.length) throw new Error("Babylon common-subset adapter rejects packets with textures; the full GLB texture mapping is required before the formal matrix.");
  if (packet.deformation) throw new Error("Babylon common-subset adapter rejects deformation packets.");
  for (const geometry of packet.geometries) {
    if (geometry.uv0 || geometry.uv1) throw new Error(`Babylon common-subset adapter rejects UV geometry: ${geometry.id}.`);
    if (geometry.tangents) throw new Error(`Babylon common-subset adapter rejects tangent geometry: ${geometry.id}.`);
    if (geometry.colors) throw new Error(`Babylon common-subset adapter rejects vertex-color geometry: ${geometry.id}.`);
  }
  for (const material of packet.materials) {
    const reject = (feature: string): never => {
      throw new Error(`Babylon common-subset adapter rejects material ${material.id}: ${feature}.`);
    };
    if (material.shadingModel === "unlit") reject("unlit shading model");
    if (material.baseColorTexture || material.metallicRoughnessTexture || material.normalTexture
      || material.occlusionTexture || material.emissiveTexture) reject("texture slots");
    if (material.emissiveFactor || material.emissiveStrength) reject("emissive inputs");
    if (material.alphaMode && material.alphaMode !== "OPAQUE") reject(`alpha mode ${material.alphaMode}`);
    if (material.baseColorAlpha !== undefined && material.baseColorAlpha !== 1) reject("base color alpha");
    if (material.premultipliedAlpha) reject("premultiplied alpha");
  }
}
