import {
  sphereMesh,
  type RenderPacket,
  type RenderView,
} from "@bim-studio/deep-engine/webgpu";

export const BENCHMARK_WIDTH = 960;
export const BENCHMARK_HEIGHT = 540;
export const BENCHMARK_DPR = 1;
export const BENCHMARK_COUNTS = Object.freeze([1_024, 10_000] as const);
export const BENCHMARK_MATERIAL = Object.freeze({ baseColor: [0.42, 0.48, 0.55] as const,
  metallic: 0.65, roughness: 0.42 });
export const BENCHMARK_BACKGROUND = Object.freeze([0.018, 0.024, 0.034] as const);
export const BENCHMARK_FLOOR = Object.freeze([0.07, 0.08, 0.095] as const);
export const BENCHMARK_LIGHT = Object.freeze({ directionWorld: [-1.6, -2.8, -1.2] as const,
  color: [2.5, 2.4, 2.25] as const, intensity: 1 });

export interface BenchmarkSceneFixture {
  readonly id: string;
  readonly instanceCount: 1024 | 10000;
  readonly extent: number;
  readonly transforms: readonly (readonly number[])[];
  readonly packet: RenderPacket;
  readonly view: RenderView;
}

export function createBenchmarkScene(instanceCount: 1024 | 10000): BenchmarkSceneFixture {
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

export function frozenFixtureDescription(fixture: BenchmarkSceneFixture): Readonly<Record<string, unknown>> {
  const geometry = fixture.packet.geometries[0]!;
  return Object.freeze({ id: fixture.id, canvas: [BENCHMARK_WIDTH, BENCHMARK_HEIGHT], dpr: BENCHMARK_DPR,
    camera: { eye: fixture.view.eye, target: fixture.view.target, up: fixture.view.up,
      verticalFovRadians: fixture.view.verticalFovRadians, near: fixture.view.near, far: fixture.view.far },
    geometry: { id: geometry.id, vertexCount: geometry.vertices.length / 6,
      indexCount: geometry.indices.length, triangleCount: geometry.indices.length / 3,
      vertices: geometry.vertices, indices: geometry.indices },
    material: BENCHMARK_MATERIAL, instanceCount: fixture.instanceCount, transforms: fixture.transforms,
    light: BENCHMARK_LIGHT, background: BENCHMARK_BACKGROUND, floor: BENCHMARK_FLOOR,
    textureSlots: 0, alphaMode: "OPAQUE" });
}
