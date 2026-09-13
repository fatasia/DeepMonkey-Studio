import {
  BENCHMARK_BACKGROUND,
  BENCHMARK_LIGHT,
  BENCHMARK_MATERIAL,
  type BenchmarkSceneFixture,
} from "./benchmarkScene.js";

export const BENCHMARK_PROFILES = Object.freeze(["baseline-equivalent", "high-native"] as const);
export type BenchmarkProfile = typeof BENCHMARK_PROFILES[number];

export const BENCHMARK_FIDELITY_IDS = Object.freeze([
  "surface", "hardware-samples", "camera", "geometry-instances", "material-inputs", "textures",
  "primary-light", "environment", "shadows", "post-process", "tone-mapping",
] as const);
export type BenchmarkFidelityId = typeof BENCHMARK_FIDELITY_IDS[number];
export interface BenchmarkFidelitySnapshot {
  readonly profile: BenchmarkProfile;
  readonly categories: Readonly<Record<BenchmarkFidelityId, unknown>>;
}

export function createBenchmarkFidelitySnapshot(engine: "deep-webgpu" | "three-webgpu",
  profile: BenchmarkProfile, fixture: BenchmarkSceneFixture, canvas: HTMLCanvasElement): BenchmarkFidelitySnapshot {
  const baseline = profile === "baseline-equivalent", geometry = fixture.packet.geometries[0]!;
  const categories: Record<BenchmarkFidelityId, unknown> = {
    surface: { width: canvas.width, height: canvas.height, dpr: fixture.view.pixelRatio, format: "preferred-srgb-output" },
    "hardware-samples": { color: 1, depth: 1 },
    camera: { projection: "perspective", eye: fixture.view.eye, target: fixture.view.target, up: fixture.view.up,
      fov: fixture.view.verticalFovRadians, near: fixture.view.near, far: fixture.view.far },
    "geometry-instances": { fixture: fixture.id, vertexFloats: geometry.vertices.length,
      indices: geometry.indices.length, instances: fixture.instanceCount, transformLayout: "column-major-mat4" },
    "material-inputs": { model: "metallic-roughness-ggx", ...BENCHMARK_MATERIAL, alphaMode: "OPAQUE" },
    textures: { count: 0 },
    "primary-light": { type: "directional", ...BENCHMARK_LIGHT },
    environment: baseline ? { enabled: false } : { enabled: true,
      source: engine === "deep-webgpu" ? "deep-procedural-studio" : "three-room-pmrem" },
    shadows: baseline ? { enabled: true, cascadeCount: 1, mapSize: 2048, filter: "linear-compare-3x3-equal",
      fit: "deep-csm-v1", depthBias: 0.00075, normalBias: "constant-one-texel", update: "static-dirty" }
      : engine === "deep-webgpu" ? { enabled: true, cascadeCount: 4, mapSize: 2048,
        filter: "pcf-soft-3x3", update: "static-dirty" }
        : { enabled: true, cascadeCount: 1, mapSize: 2048, filter: "three-pcf-soft", update: "static-dirty" },
    "post-process": baseline ? disabledEffects() : engine === "deep-webgpu"
      ? { ambientOcclusion: true, temporalAa: true, bloom: true, vignette: true, fog: true, groundGrid: true }
      : disabledEffects(),
    "tone-mapping": baseline || engine === "three-webgpu"
      ? { operator: "three-aces-r185", exposure: 1, outputTransfer: "srgb" }
      : { operator: "deep-aces", exposure: 1, outputTransfer: "srgb" },
  };
  return Object.freeze({ profile, categories: Object.freeze(categories) });
}

export function benchmarkRenderSettings(candidate: BenchmarkFidelitySnapshot,
  reference: BenchmarkFidelitySnapshot): Readonly<Record<string, unknown>> {
  return Object.freeze({ profile: candidate.profile, candidate: candidate.categories, reference: reference.categories });
}

function disabledEffects() {
  return Object.freeze({ ambientOcclusion: false, temporalAa: false, bloom: false,
    vignette: false, fog: false, groundGrid: false });
}
