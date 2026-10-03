// T18 A3 并行布料 probe 共享职责(sourceSizeGate 拆分:自 clothParallelGpuProbe.ts
// 按职责分文件,代码逐行同源,仅改可见性;语义零变化)。
// 职责:场景常量、适配器冒烟、状态指纹/拉伸带度量、GPU 上下文缓存与 uncapturederror 常驻监听。
import { buildClothParallelState, fingerprintFloat32 } from "../src/physics/clothParallelSolver.js";
import { DEEP_CLOTH_PARALLEL_SOLVER_WGSL } from "../src/physics/clothSolverWgsl.js";

export const GRID = {
  columns: 12, rows: 12, spacing: 0.1, mass: 0.2,
  gravity: [0, -9.81, 0], dtSeconds: 1 / 60, substeps: 8, compliance: 0, damping: 0.01,
  perturbation: 0.005, seed: 20260927, origin: [0, 0, 0],
};
export const PINNED = [[0, 11], [11, 11]];
export const TICKS = 240;

export async function probeAdapterInfo(): Promise<unknown> {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error("WebGPU adapter unavailable");
  return adapter.info ?? {};
}

export function stateFingerprint(state: Float32Array, particleCount: number): string {
  const all = new Float32Array(particleCount * 6);
  for (let i = 0; i < particleCount; i += 1) {
    all[i] = state[i * 12]!;
    all[particleCount + i] = state[i * 12 + 1]!;
    all[2 * particleCount + i] = state[i * 12 + 2]!;
    all[3 * particleCount + i] = state[i * 12 + 4]!;
    all[4 * particleCount + i] = state[i * 12 + 5]!;
    all[5 * particleCount + i] = state[i * 12 + 6]!;
  }
  return fingerprintFloat32(all);
}

export function stretchMaxRatio(state: Float32Array, build: ReturnType<typeof buildClothParallelState>): number {
  const constraints = new Uint32Array(build.constraintBuffer);
  const rests = new Float32Array(build.constraintBuffer);
  let max = 0;
  for (let bucket = 0; bucket < build.constraintCount; bucket += 1) {
    const a = constraints[bucket * 4]!;
    const b = constraints[bucket * 4 + 1]!;
    const rest = rests[bucket * 4 + 2]!;
    const dx = state[a * 12]! - state[b * 12]!;
    const dy = state[a * 12 + 1]! - state[b * 12 + 1]!;
    const dz = state[a * 12 + 2]! - state[b * 12 + 2]!;
    const ratio = Math.abs(Math.hypot(dx, dy, dz) - rest) / rest;
    if (ratio > max) max = ratio;
  }
  return max;
}

let cachedModule: { device: GPUDevice; module: GPUShaderModule } | null = null;

// 定位诊断(临时,softbody-divergence-20261002):设备侧未捕获错误(验证错误在此不抛
// 异常、只走 uncapturederror,不监听就看不到)。
export const gpuUncapturedErrors: string[] = [];

export async function gpuContext(): Promise<{ device: GPUDevice; module: GPUShaderModule }> {
  if (cachedModule) return cachedModule;
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error("WebGPU adapter unavailable");
  const device = await adapter.requestDevice();
  device.addEventListener("uncapturederror", (event) => {
    const message = (event as GPUUncapturedErrorEvent).error?.message ?? String(event);
    if (gpuUncapturedErrors.length < 32) gpuUncapturedErrors.push(message.slice(0, 300));
  });
  const module = device.createShaderModule({ code: DEEP_CLOTH_PARALLEL_SOLVER_WGSL });
  const info = await module.getCompilationInfo();
  const fatal = info.messages.filter((message) => message.type === "error");
  if (fatal.length) throw new Error(`WGSL compile failed: ${fatal.map((m) => m.message).join("; ")}`);
  cachedModule = { device, module };
  return cachedModule;
}
