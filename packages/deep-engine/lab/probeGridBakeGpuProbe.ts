/**
 * Deep GI 探针网格烘焙真机证据探针（F3 编排切片）：headless Chrome + 真 WebGPU，
 * 走完整生产链（ProbeGridBakeService：ProbeSceneRadianceProducer 捕获 → 捕获纹理
 * copyTextureToBuffer 读回 → decodeProbeGridCapture → aggregateProbeGridBake →
 * packNativeProbeGridRecords 编译器输入校验）。场景沿用 F1 辐射取证的同款 fixture
 * （y=0 地面 + 悬空盒），网格 2×2×2 单层（origin [0,0.5,0]、spacing 2），逐 cell 与
 * CPU 参考（cpuReferenceFor：同一着色公式）对拍。模式完全沿用 probeRadianceGpuTest.mjs
 * （esbuild bundle + playwright headless）。
 */

import type { RenderPacket } from "../src/renderPacket.js";
import {
  ProbeGridBakeService, type ProbeGridBakeEvidence,
} from "../src/rayTracing/probeGridBakeService.js";
import { emitProbeRadianceKernelWgsl } from "../src/rayTracing/probeRadianceKernel.js";
import { cpuReferenceFor } from "./probeRadianceGpuProbe.js";

export { emitProbeRadianceKernelWgsl };

export interface ProbeGridBakeGpuResult {
  /** 两次独立 bake 的产物（真机确定性对拍用）。 */
  readonly runs: readonly {
    readonly evidence: ProbeGridBakeEvidence;
    /** 逐 cell GPU vs CPU 参考的绝对差（f16 存储量化容差 1e-3）。 */
    readonly comparisons: readonly {
      readonly cell: readonly [number, number, number];
      readonly position: readonly [number, number, number];
      readonly gpu: readonly [number, number, number];
      readonly cpu: readonly [number, number, number];
      readonly absoluteDelta: readonly [number, number, number];
      readonly passed: boolean;
    }[];
  }[];
  readonly identicalAcrossRuns: boolean;
  readonly occludedBelowOpenSky: boolean;
  readonly packerAccepted: boolean;
  readonly adapter: string;
  readonly errors: readonly string[];
}

const DIRECTION_COUNT = 8, T_MAX = 32;
const SUN = { surfaceToLightWorld: [0, 1, 0], color: [1, 1, 1], intensity: 3 } as const;
const AMBIENT = [0.05, 0.05, 0.06] as const;
const GROUND_ALBEDO = [0.6, 0.55, 0.5] as const, BOX_ALBEDO = [0.2, 0.8, 0.4] as const;
const GRID = { origin: [0, 0.5, 0], spacing: 2, gridSize: [2, 2, 2] } as const;
/** f16 存储量化容差（与 F1 逐探针对拍同口径：abs floor 1e-3）。 */
const ABSOLUTE_TOLERANCE = 1e-3;

/** 与 lab/probeRadianceGpuProbe.ts 同款场景（地面 + 悬空盒，世界坐标 identity 变换）。 */
function bakeCasePacket(): RenderPacket {
  const size = 10;
  const ground = new Float32Array([
    -size, 0, -size, 0, 1, 0, size, 0, -size, 0, 1, 0, size, 0, size, 0, 1, 0,
    -size, 0, -size, 0, 1, 0, size, 0, size, 0, 1, 0, -size, 0, size, 0, 1, 0]);
  const h = 0.5, cy = 1.5;
  const v = (x: number, y: number, z: number): number[] => [x, cy + y, z];
  const boxFaces: number[][][] = [
    [[-h, h, -h], [-h, h, h], [h, h, h], [-h, h, -h], [h, h, h], [h, h, -h]],
    [[-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, -h], [h, -h, h], [-h, -h, h]],
    [[-h, -h, h], [h, -h, h], [h, h, h], [-h, -h, h], [h, h, h], [-h, h, h]],
    [[h, -h, -h], [-h, -h, -h], [-h, h, -h], [h, -h, -h], [-h, h, -h], [h, h, -h]],
    [[h, -h, h], [h, -h, -h], [h, h, -h], [h, -h, h], [h, h, -h], [h, h, h]],
    [[-h, -h, -h], [-h, -h, h], [-h, h, h], [-h, -h, -h], [-h, h, h], [-h, h, -h]],
  ];
  const normals: number[][] = [[0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0]];
  const boxVertices: number[] = [];
  boxFaces.forEach((face, index) => face.forEach(vertex =>
    boxVertices.push(...v(vertex[0] as number, vertex[1] as number, vertex[2] as number), ...normals[index]!)));
  return {
    geometries: [
      { id: "ground", revision: 0, vertices: ground, indices: new Uint32Array([0, 1, 2, 3, 4, 5]) },
      { id: "box", revision: 0, vertices: new Float32Array(boxVertices),
        indices: new Uint32Array(Array.from({ length: 36 }, (_, index) => index)) },
    ],
    materials: [
      { id: "ground-m", baseColor: GROUND_ALBEDO, metallic: 0, roughness: 1 },
      { id: "box-m", baseColor: BOX_ALBEDO, metallic: 0, roughness: 1 },
    ],
    instances: [
      { id: "ground-1", geometry: "ground", material: "ground-m",
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
      { id: "box-1", geometry: "box", material: "box-m",
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
    ],
  };
}

export async function runProbeGridBakeGpuProbe(): Promise<ProbeGridBakeGpuResult> {
  if (!navigator.gpu) throw new Error("navigator.gpu unavailable.");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("requestAdapter returned null.");
  const device = await adapter.requestDevice({ label: "probe-grid-bake-gpu-probe" });
  const errors: string[] = [];
  device.addEventListener?.("uncapturederror", event => {
    errors.push(`uncaptured: ${(event as GPUUncapturedErrorEvent).error.message}`);
  });
  try {
    const packet = bakeCasePacket();
    const service = new ProbeGridBakeService(device, {
      lighting: { primary: SUN, ambient: AMBIENT }, directionCount: DIRECTION_COUNT, maxDistance: T_MAX });
    const runs: { evidence: ProbeGridBakeEvidence; comparisons: ProbeGridBakeGpuResult["runs"][number]["comparisons"] }[] = [];
    // 两次独立 bake（generation 递增真实重捕获）：同输入必须逐位同产物——真机确定性证据。
    for (let run = 0; run < 2; run++) {
      const evidence = await service.bake(packet, GRID);
      const albedos: readonly (readonly [number, number, number])[] = [GROUND_ALBEDO, BOX_ALBEDO];
      const comparisons = evidence.bake.probes.map((probe, index) => {
        const update = { cell: [index % 2, Math.floor(index / 2) % 2, Math.floor(index / 4)] } as const;
        // 位置 = origin + cell * spacing（与 planProbeGridCapture 一致）。
        const position: readonly [number, number, number] = [
          GRID.origin[0] + update.cell[0] * GRID.spacing,
          GRID.origin[1] + update.cell[1] * GRID.spacing,
          GRID.origin[2] + update.cell[2] * GRID.spacing];
        const cpu = cpuReferenceFor(packet, position, albedos).mean;
        const absoluteDelta = [0, 1, 2].map(axis =>
          Math.abs(probe.irradiance[axis]! - cpu[axis]!)) as [number, number, number];
        return { cell: [...update.cell] as readonly [number, number, number], position,
          gpu: probe.irradiance, cpu, absoluteDelta,
          passed: absoluteDelta.every(delta => delta <= ABSOLUTE_TOLERANCE) };
      });
      runs.push({ evidence, comparisons });
    }
    service.dispose();

    const [first, second] = runs;
    const serialize = (run: ProbeGridBakeGpuResult["runs"][number]): string =>
      JSON.stringify(run.evidence.bake);
    const identicalAcrossRuns = serialize(first!) === serialize(second!);
    // 语义断言：盒下方遮挡 cell (0,0,0) 亮度 < 开阔 cell (1,0,0)（同一 y/z 行，仅 x 不同）。
    const luminance = (probe: readonly number[]): number => probe[0]! + probe[1]! + probe[2]!;
    const occluded = first!.evidence.bake.probes[0]!.irradiance;
    const openSky = first!.evidence.bake.probes[1]!.irradiance;
    // 编译器输入校验已在 bake 内跑过（packNativeProbeGridRecords），此处记录结果并补数量合同。
    const packerAccepted = first!.evidence.bake.probes.length === 8
      && first!.evidence.overflowSentinel === 0 && second!.evidence.overflowSentinel === 0;
    return {
      runs: runs.map(run => ({
        evidence: { ...run.evidence, bake: { ...run.evidence.bake,
          origin: [...run.evidence.bake.origin] as readonly [number, number, number],
          gridSize: [...run.evidence.bake.gridSize] as readonly [number, number, number],
          probes: run.evidence.bake.probes.map(probe => ({ ...probe,
            irradiance: [...probe.irradiance] as readonly [number, number, number] })) } },
        comparisons: run.comparisons,
      })),
      identicalAcrossRuns,
      occludedBelowOpenSky: luminance(occluded) < luminance(openSky),
      packerAccepted,
      adapter: (adapter as GPUAdapter & { info?: { description?: string } }).info?.description ?? "",
      errors,
    };
  } finally { device.destroy(); }
}
