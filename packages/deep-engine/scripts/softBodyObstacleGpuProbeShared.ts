// F6/T18 软体并行核障碍刀 共享职责(sourceSizeGate 拆分:自 softBodyObstacleGpuProbe.ts
// 按职责分文件,代码逐行同源,仅改可见性;语义零变化)。
// 职责:uncapturederror 常驻监听、GPU 上下文缓存、几何/刚体夹具构造。
import type { DynamicPhysicsBodyRuntime } from "../src/runtimePackage/dynamicSceneRuntime.js";
import { SOFT_BODY_PARALLEL_SOLVER_WGSL } from "../src/physics/softBodyParallelSolverWgsl.js";

export const gpuUncapturedErrors: string[] = [];

export async function probeAdapterInfo(): Promise<unknown> {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error("WebGPU adapter unavailable");
  return { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description };
}

let cachedDevice: GPUDevice | null = null;
let cachedModule: GPUShaderModule | null = null;

export async function gpuContext(): Promise<{ device: GPUDevice; module: GPUShaderModule }> {
  if (cachedDevice && cachedModule) return { device: cachedDevice, module: cachedModule };
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error("WebGPU adapter unavailable");
  const device = await adapter.requestDevice();
  device.addEventListener("uncapturederror", (event) => {
    const message = (event as GPUUncapturedErrorEvent).error?.message ?? String(event);
    if (gpuUncapturedErrors.length < 32) gpuUncapturedErrors.push(message.slice(0, 300));
  });
  const module = device.createShaderModule({ code: SOFT_BODY_PARALLEL_SOLVER_WGSL });
  const info = await module.getCompilationInfo();
  const fatal = info.messages.filter((message) => message.type === "error");
  if (fatal.length) throw new Error(`WGSL compile failed: ${fatal.map((m) => m.message).join("; ")}`);
  cachedDevice = device; cachedModule = module;
  return { device, module };
}

export function rotationFromQuaternion(q: readonly [number, number, number, number]): readonly [number, number, number, number, number, number, number, number, number] {
  const length = Math.hypot(...q);
  const [x, y, z, w] = q.map(v => v / length) as [number, number, number, number];
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

export function toWorld(center: readonly [number, number, number], r: readonly number[], local: readonly [number, number, number]): [number, number, number] {
  return [
    center[0] + r[0]! * local[0] + r[1]! * local[1] + r[2]! * local[2],
    center[1] + r[3]! * local[0] + r[4]! * local[1] + r[5]! * local[2],
    center[2] + r[6]! * local[0] + r[7]! * local[1] + r[8]! * local[2],
  ];
}

export function fixedBody(id: string, translation: readonly number[], q: readonly [number, number, number, number],
  primitive: { shape: "sphere"; radius: number } | { shape: "cuboid"; halfExtents: readonly [number, number, number] }): DynamicPhysicsBodyRuntime {
  return {
    id, type: "fixed", mass: 0, friction: 0, restitution: 0,
    initialPose: { translation: [...translation] as [number, number, number], rotation: [...q] as [number, number, number, number] },
    collider: { kind: "primitive", instanceIds: [], primitive },
  } as unknown as DynamicPhysicsBodyRuntime;
}
