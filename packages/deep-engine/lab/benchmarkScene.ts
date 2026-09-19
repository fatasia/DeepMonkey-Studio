import {
  sphereMesh,
  type RenderPacket,
  type RenderView,
} from "@bim-studio/deep-engine/webgpu";
import { loadModelPacket, modelSourceIdentity, modelCameraFrame, type BenchmarkCameraFrame, type ModelName } from "./modelPacket.js";
import { benchmarkPacketSphere } from "./benchmarkPacketBounds.js";

export const BENCHMARK_WIDTH = 960;
export const BENCHMARK_HEIGHT = 540;
export const BENCHMARK_DPR = 1;
export const BENCHMARK_COUNTS = Object.freeze([1, 1_024, 10_000] as const);
export type BenchmarkInstanceCount = typeof BENCHMARK_COUNTS[number];
export const BENCHMARK_MATERIAL = Object.freeze({ baseColor: [0.42, 0.48, 0.55] as const,
  metallic: 0.65, roughness: 0.42 });
export const BENCHMARK_BACKGROUND = Object.freeze([0.018, 0.024, 0.034] as const);
export const BENCHMARK_FLOOR = Object.freeze([0.07, 0.08, 0.095] as const);
export const BENCHMARK_LIGHT = Object.freeze({ directionWorld: [-1.6, -2.8, -1.2] as const,
  color: [2.5, 2.4, 2.25] as const, intensity: 1 });

export interface BenchmarkSceneFixture {
  readonly id: string;
  readonly instanceCount: BenchmarkInstanceCount;
  readonly extent: number;
  readonly transforms: readonly (readonly number[])[];
  readonly packet: RenderPacket;
  readonly view: RenderView;
  readonly assetIdentity?: { readonly sha256: string; readonly sourceSha256: string };
  readonly cameraFrame?: BenchmarkCameraFrame;
}

export function createBenchmarkScene(instanceCount: BenchmarkInstanceCount): BenchmarkSceneFixture {
  if (!BENCHMARK_COUNTS.includes(instanceCount)) throw new RangeError("Benchmark instance count is not frozen.");
  const side = Math.ceil(Math.sqrt(instanceCount)), spacing = 2.1, scale = 0.74;
  const extent = Math.max(4, side * 1.55);
  const transforms = Object.freeze(Array.from({ length: instanceCount }, (_, index) => {
    const x = index % side, z = Math.floor(index / side), angle = index * 0.61803398875;
    const c = Math.cos(angle) * scale, s = Math.sin(angle) * scale;
    return Object.freeze([c, 0, -s, 0, 0, scale, 0, 0, s, 0, c, 0,
      (x - (side - 1) / 2) * spacing, scale, (z - (side - 1) / 2) * spacing, 1]);
  }));
  const mesh = sphereMesh(40, 24);
  const packet: RenderPacket = Object.freeze({
    geometries: Object.freeze([{ id: "benchmark-sphere-40x24", revision: 1, ...mesh }]),
    materials: Object.freeze([{ id: "benchmark-pbr", ...BENCHMARK_MATERIAL }]),
    instances: Object.freeze(transforms.map((transform, index) => Object.freeze({
      id: `instance-${index}`, geometry: "benchmark-sphere-40x24", material: "benchmark-pbr", transform,
    }))),
  });
  const radius = extent * Math.max(2.7, 2.7 / (BENCHMARK_WIDTH / BENCHMARK_HEIGHT));
  const view: RenderView = Object.freeze({ width: BENCHMARK_WIDTH, height: BENCHMARK_HEIGHT,
    pixelRatio: BENCHMARK_DPR, eye: [radius * 0.42, radius * 0.66, radius * 0.66] as const,
    target: [0, -extent * 0.08, 0] as const, up: [0, 1, 0] as const, extent,
    background: BENCHMARK_BACKGROUND, floor: BENCHMARK_FLOOR, exposure: 1, roughness: 1,
    verticalFovRadians: Math.PI / 4, near: 0.1, far: extent * 20,
    lights: { directional: [BENCHMARK_LIGHT] },
  });
  return Object.freeze({ id: `instanced-opaque-pbr-${instanceCount}`, instanceCount, extent,
    transforms, packet, view });
}

/**
 * Builds the same benchmark contract from an unmodified GLB served by the Lab.
 * This is intentionally separate from the procedural scene so reports can state
 * whether measurements came from a real asset or a synthetic stress fixture.
 */
export async function createAssetBenchmarkScene(name: ModelName, instanceCount: BenchmarkInstanceCount,
  signal?: AbortSignal): Promise<BenchmarkSceneFixture> {
  const packet = await loadModelPacket(name, instanceCount, signal);
  const transforms = Object.freeze(packet.instances.map(instance => Object.freeze(Array.from(instance.transform))));
  const triangles = packet.geometries.reduce((sum, geometry) => sum + geometry.indices.length / 3, 0);
  if (!packet.instances.length || !Number.isFinite(triangles) || triangles <= 0) throw new Error("GLB benchmark asset has no renderable triangles.");
  const sphere = benchmarkPacketSphere(packet), cameraFrame = modelCameraFrame(name);
  const extent = Math.max(0.1, cameraFrame?.radius ?? sphere.radius);
  const center = cameraFrame?.center ?? sphere.center.toArray() as [number, number, number];
  const view: RenderView = Object.freeze({ width: BENCHMARK_WIDTH, height: BENCHMARK_HEIGHT,
    pixelRatio: BENCHMARK_DPR, eye: [center[0] + extent * 1.4, center[1] + extent * 1.5, center[2] + extent * 1.8] as const,
    target: center, up: [0, 1, 0] as const, extent,
    background: BENCHMARK_BACKGROUND, floor: BENCHMARK_FLOOR, exposure: 1, roughness: 1,
    verticalFovRadians: Math.PI / 4, near: 0.1, far: extent * 20,
    lights: { directional: [BENCHMARK_LIGHT] },
  });
  const assetIdentity = modelSourceIdentity(name);
  return Object.freeze({ id: `asset-${name}-${instanceCount}`, instanceCount, extent, transforms, packet, view,
    ...(assetIdentity ? { assetIdentity } : {}), ...(cameraFrame ? { cameraFrame } : {}) });
}

export function frozenFixtureDescription(fixture: BenchmarkSceneFixture): Readonly<Record<string, unknown>> {
  return Object.freeze({ id: fixture.id, canvas: [BENCHMARK_WIDTH, BENCHMARK_HEIGHT], dpr: BENCHMARK_DPR,
    ...(fixture.assetIdentity ? { assetIdentity: fixture.assetIdentity } : {}),
    ...(fixture.cameraFrame ? { cameraFrame: fixture.cameraFrame } : {}),
    camera: { eye: fixture.view.eye, target: fixture.view.target, up: fixture.view.up,
      verticalFovRadians: fixture.view.verticalFovRadians, near: fixture.view.near, far: fixture.view.far },
    packet: fixture.packet, instanceCount: fixture.packet.instances.length,
    light: BENCHMARK_LIGHT, background: BENCHMARK_BACKGROUND, floor: BENCHMARK_FLOOR,
    textureSlots: fixture.packet.textures?.length ?? 0 });
}
