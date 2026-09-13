import * as THREE from "three/webgpu";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { planCascadedShadows } from "@bim-studio/deep-engine";
import { captureWebGpuBenchmarkImage } from "./benchmarkImage.js";
import type { BenchmarkBackend, BenchmarkFrameStats } from "./benchmarkBackend.js";
import {
  BENCHMARK_BACKGROUND,
  BENCHMARK_FLOOR,
  BENCHMARK_HEIGHT,
  BENCHMARK_LIGHT,
  BENCHMARK_MATERIAL,
  BENCHMARK_DPR,
  BENCHMARK_WIDTH,
  type BenchmarkSceneFixture,
} from "./benchmarkScene.js";
import { createBenchmarkFidelitySnapshot, type BenchmarkFidelitySnapshot,
  type BenchmarkProfile } from "./benchmarkProfile.js";
import { deepBaselineShadowFilter } from "./threeBaselineShadowFilter.js";

interface WebGpuBackendAccess {
  readonly isWebGPUBackend?: boolean;
  readonly device?: GPUDevice;
  readonly context?: GPUCanvasContext;
}

/** A real Three WebGPU path with instancing, frustum culling, PMREM IBL, ACES and PCF shadows. */
export class ThreeWebGpuBenchmarkBackend implements BenchmarkBackend {
  readonly id = "three-webgpu";
  readonly version = "0.185.1";
  readonly adapter: Readonly<Record<string, unknown>>;
  private readonly failures: string[] = [];

  private constructor(private readonly canvas: HTMLCanvasElement, private readonly renderer: THREE.WebGPURenderer,
    private readonly scene: THREE.Scene, private readonly camera: THREE.PerspectiveCamera,
    private readonly device: GPUDevice, private readonly context: GPUCanvasContext, adapter: GPUAdapterInfo,
    private readonly resources: readonly { dispose(): void }[], private readonly timestampEnabled: boolean,
    readonly profile: BenchmarkProfile, readonly fidelity: BenchmarkFidelitySnapshot) {
    this.adapter = Object.freeze({ vendor: adapter.vendor, architecture: adapter.architecture,
      device: adapter.device, description: adapter.description, isFallbackAdapter: adapter.isFallbackAdapter });
    renderer.onDeviceLost = info => this.failures.push(`lost: ${info.message}`);
    renderer.onError = message => this.failures.push(`error: ${message}`);
    device.addEventListener("uncapturederror", this.onDeviceError);
  }

  static async create(canvas: HTMLCanvasElement, fixture: BenchmarkSceneFixture,
    signal: AbortSignal, enableTimestamp: boolean, profile: BenchmarkProfile): Promise<ThreeWebGpuBenchmarkBackend> {
    signal.throwIfAborted();
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("Three WebGPU benchmark adapter is unavailable.");
    const features = enableTimestamp && adapter.features.has("timestamp-query") ? ["timestamp-query" as GPUFeatureName] : [];
    const device = await adapter.requestDevice({ label: "Three 0.185.1 benchmark device",
      ...(features.length ? { requiredFeatures: features } : {}) });
    const renderer = new THREE.WebGPURenderer({ canvas, device, alpha: false, antialias: false,
      powerPreference: "high-performance", trackTimestamp: features.length > 0 });
    const resources: { dispose(): void }[] = [];
    try {
      await renderer.init(); signal.throwIfAborted();
      const backend = renderer.backend as unknown as WebGpuBackendAccess;
      if (backend.isWebGPUBackend !== true || backend.device !== device || !backend.context) {
        throw new Error("Three selected a non-WebGPU backend.");
      }
      renderer.setPixelRatio(BENCHMARK_DPR); renderer.setSize(BENCHMARK_WIDTH, BENCHMARK_HEIGHT, false);
      renderer.info.autoReset = false;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1;
      renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      const prepared = prepareScene(renderer, fixture, profile); resources.push(...prepared.resources);
      const fidelity = createBenchmarkFidelitySnapshot("three-webgpu", profile, fixture, canvas);
      const result = new ThreeWebGpuBenchmarkBackend(canvas, renderer, prepared.scene, prepared.camera,
        device, backend.context, adapter.info, resources, features.length > 0, profile, fidelity);
      await renderer.compileAsync(prepared.scene, prepared.camera);
      result.render(); await result.settle(); signal.throwIfAborted();
      return result;
    } catch (error) {
      for (const resource of resources.reverse()) resource.dispose();
      renderer.dispose(); device.destroy(); throw error;
    }
  }

  get timestampSupported(): boolean { return this.timestampEnabled; }

  setGpuInstrumentation(enabled: boolean): void {
    if (enabled !== this.timestampEnabled) throw new Error("Three timestamp instrumentation was not frozen at initialization.");
  }

  render(): BenchmarkFrameStats {
    const started = performance.now();
    this.renderer.info.reset();
    this.renderer.render(this.scene, this.camera);
    const rendered = performance.now();
    const info = this.renderer.info;
    const resources = Object.entries(info.memory).filter(([key]) => !key.endsWith("Size") && key !== "total")
      .reduce((total, [, value]) => total + value, 0);
    return Object.freeze({ drawCalls: info.render.drawCalls, triangles: info.render.triangles, resources,
      cpuStages: Object.freeze({ renderCallMs: rendered - started, statisticsReadMs: performance.now() - rendered }) });
  }

  async settle(): Promise<void> { await this.device.queue.onSubmittedWorkDone(); }

  async measureGpuFrame(): Promise<number | null> {
    if (!this.timestampSupported) return null;
    this.renderer.info.reset();
    this.renderer.render(this.scene, this.camera);
    // Three r185 already converts WebGPU nanoseconds with /1e6 inside WebGPUTimestampQueryPool.
    const value = await this.renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER);
    if (value === undefined || !Number.isFinite(value) || value < 0) throw new Error("Three GPU timestamp readback did not resolve.");
    return value;
  }

  capture() {
    this.render();
    return captureWebGpuBenchmarkImage(this.device, this.context, navigator.gpu.getPreferredCanvasFormat(),
      this.canvas.width, this.canvas.height);
  }
  errors(): readonly string[] { return this.failures.slice(); }
  dispose(): void {
    this.device.removeEventListener("uncapturederror", this.onDeviceError);
    for (const resource of [...this.resources].reverse()) resource.dispose();
    this.renderer.dispose(); this.device.destroy();
  }

  private readonly onDeviceError = (event: Event): void => {
    event.preventDefault(); this.failures.push(`uncaptured: ${(event as GPUUncapturedErrorEvent).error.message}`);
  };
}

function prepareScene(renderer: THREE.WebGPURenderer, fixture: BenchmarkSceneFixture, profile: BenchmarkProfile) {
  const scene = new THREE.Scene(); scene.background = new THREE.Color().setRGB(...BENCHMARK_BACKGROUND);
  const source = fixture.packet.geometries[0]!, positions = new Float32Array(source.vertices.length / 2);
  const normals = new Float32Array(source.vertices.length / 2);
  for (let sourceOffset = 0, target = 0; sourceOffset < source.vertices.length; sourceOffset += 6, target += 3) {
    positions.set(source.vertices.subarray(sourceOffset, sourceOffset + 3), target);
    normals.set(source.vertices.subarray(sourceOffset + 3, sourceOffset + 6), target);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(source.indices, 1)); geometry.computeBoundingSphere();
  const material = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(...BENCHMARK_MATERIAL.baseColor),
    metalness: BENCHMARK_MATERIAL.metallic, roughness: BENCHMARK_MATERIAL.roughness });
  const mesh = new THREE.InstancedMesh(geometry, material, fixture.instanceCount); mesh.castShadow = true;
  const matrix = new THREE.Matrix4(); fixture.transforms.forEach((transform, index) => mesh.setMatrixAt(index, matrix.fromArray(transform)));
  mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere(); scene.add(mesh);
  const floorGeometry = new THREE.PlaneGeometry(fixture.extent * 16, fixture.extent * 16);
  const floorMaterial = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(...BENCHMARK_FLOOR),
    metalness: 0, roughness: 0.9 });
  const floor = new THREE.Mesh(floorGeometry, floorMaterial); floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.02; floor.receiveShadow = true; scene.add(floor);
  const sun = new THREE.DirectionalLight(new THREE.Color().setRGB(...BENCHMARK_LIGHT.color), BENCHMARK_LIGHT.intensity);
  configureBenchmarkShadow(sun, fixture, profile); scene.add(sun, sun.target);
  const camera = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(fixture.view.verticalFovRadians!),
    fixture.view.width / fixture.view.height,
    fixture.view.near, fixture.view.far);
  camera.position.fromArray(fixture.view.eye); camera.up.fromArray(fixture.view.up!);
  camera.lookAt(new THREE.Vector3().fromArray(fixture.view.target)); camera.updateMatrixWorld(true);
  const resources: { dispose(): void }[] = [floorGeometry, floorMaterial, geometry, material];
  if (profile === "high-native") {
    const room = new RoomEnvironment(), pmrem = new THREE.PMREMGenerator(renderer as never);
    const environment = pmrem.fromScene(room); scene.environment = environment.texture;
    resources.unshift(environment, pmrem, room);
  }
  return { scene, camera, resources };
}

export function configureBenchmarkShadow(sun: THREE.DirectionalLight,
  fixture: BenchmarkSceneFixture, profile: BenchmarkProfile): void {
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.00075;
  sun.shadow.autoUpdate = false; sun.shadow.needsUpdate = true;
  if (profile === "baseline-equivalent") {
    (sun.shadow as THREE.DirectionalLightShadow & { filterNode: unknown }).filterNode = deepBaselineShadowFilter;
    const plan = planCascadedShadows({ eye: fixture.view.eye, target: fixture.view.target, up: fixture.view.up!,
      verticalFovRadians: fixture.view.verticalFovRadians!, aspect: BENCHMARK_WIDTH / BENCHMARK_HEIGHT,
      near: fixture.view.near!, far: fixture.view.far! }, BENCHMARK_LIGHT.directionWorld,
    { cascadeCount: 1, shadowMapSize: 2048, splitLambda: 0, blendRatio: 0,
      ...(fixture.view.far === undefined ? {} : { maxShadowDistance: fixture.view.far }),
      depthPadding: fixture.extent * 0.2 });
    const slice = plan.cascades[0]!, direction = new THREE.Vector3(...plan.lightDirection);
    const center = new THREE.Vector3(...slice.center), distance = slice.radius + fixture.extent * 0.2;
    sun.position.copy(center).addScaledVector(direction, -distance); sun.target.position.copy(center);
    Object.assign(sun.shadow.camera, { left: -slice.radius, right: slice.radius, top: slice.radius,
      bottom: -slice.radius, near: 0, far: 2 * distance });
    sun.shadow.normalBias = slice.texelWorldSize; sun.shadow.camera.updateProjectionMatrix(); return;
  }
  sun.position.set(-BENCHMARK_LIGHT.directionWorld[0] * fixture.extent,
    -BENCHMARK_LIGHT.directionWorld[1] * fixture.extent, -BENCHMARK_LIGHT.directionWorld[2] * fixture.extent);
  sun.target.position.set(0, 0, 0); const boundary = fixture.extent * 1.5;
  Object.assign(sun.shadow.camera, { left: -boundary, right: boundary, top: boundary, bottom: -boundary,
    near: 0.1, far: fixture.extent * 8 });
  sun.shadow.camera.updateProjectionMatrix();
}
