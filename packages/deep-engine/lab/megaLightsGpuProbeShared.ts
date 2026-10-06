/// <reference types="@webgpu/types" />
// megaLightsGpuProbe 腿间共享层(体量门拆分;条目逐字未改):
// 裸设备会话壳、设备请求、perf 场景构造与帧执行/读回/编译诊断助手。
import type { DeviceSession } from "../src/webgpu/deviceSession.js";
import { MegaLightsRuntime } from "../src/lighting/megaLightsRuntime.js";
import type { ClusteredLights, PointLight } from "../src/lighting/types.js";

export type LightingSessionShim = Pick<DeviceSession, "device" | "state" | "own" | "release">;

/** 真机 leg 共用的裸设备会话壳(own/release 语义与 DeviceSession 对齐:destroy 即释放)。 */
export function shimSession(device: GPUDevice): LightingSessionShim {
  return { device, state: "ready",
    own<T extends { destroy(): void }>(resource: T): T { return resource; },
    release(resource: { destroy(): void }): void { resource.destroy(); } };
}

export async function requestDevice(): Promise<GPUDevice> {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("requestAdapter returned null.");
  return adapter.requestDevice();
}

// ---- 场景构造(确定性) ----

export const PERF_LIGHT_COUNT = 5000;
export const PERF_WIDTH = 1920, PERF_HEIGHT = 1080;

/** 5000 点光(10% 移动):第 index%10===0 号灯随帧做正弦漂移。 */
export function buildPerfLights(frame: number): ClusteredLights {
  const points: PointLight[] = [];
  for (let index = 0; index < PERF_LIGHT_COUNT; index++) {
    const angle = index * 2.399963229728653;
    const radius = 1.5 + (index % 11) * 0.55;
    const moving = index % 10 === 0;
    const wobble = moving ? Math.sin(frame * 0.07 + index) * 0.6 : 0;
    points.push({
      positionView: [Math.cos(angle) * radius + wobble, 0.5 + Math.sin(angle * 1.7) * 0.8,
        1.2 + Math.cos(angle * 0.6) * 0.5 + (moving ? Math.cos(frame * 0.05 + index) * 0.4 : 0)],
      range: 0, color: [1, 0.95 - (index % 4) * 0.08, 0.9 - (index % 3) * 0.12],
      intensity: 0.5 + (index % 7) * 0.25, decay: 2,
    });
  }
  return { points };
}

/** 1920×1080 视空间表面:z=−3 朗伯墙,逐像素轻微法线扰动(确定性)。 */
export function buildPerfSurfaces(width: number, height: number): Float32Array {
  const surfaces = new Float32Array(width * height * 3 * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 3 * 4;
      const px = (x / width - 0.5) * 3.2, py = (0.5 - y / height) * 1.8;
      surfaces[index] = px; surfaces[index + 1] = py; surfaces[index + 2] = -3;
      surfaces[index + 3] = 0; // metallic
      const nx = Math.sin(x * 0.013) * 0.15, ny = Math.cos(y * 0.017) * 0.15;
      const nl = 1 / Math.hypot(nx, ny, 1);
      surfaces[index + 4] = nx * nl; surfaces[index + 5] = ny * nl; surfaces[index + 6] = nl;
      surfaces[index + 7] = 0.5; // roughness
      surfaces[index + 8] = 0.8; surfaces[index + 9] = 0.78; surfaces[index + 10] = 0.75;
    }
  }
  return surfaces;
}

export async function readbackColor(device: GPUDevice, runtime: MegaLightsRuntime): Promise<Float32Array> {
  const pixels = runtime.pixelCount;
  const buffer = device.createBuffer({ label: "MegaLights probe color readback", size: pixels * 16,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = device.createCommandEncoder({ label: "MegaLights probe readback" });
    encoder.copyBufferToBuffer(runtime.colorBuffer, 0, buffer, 0, pixels * 16);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    return new Float32Array(buffer.getMappedRange().slice(0));
  } finally { buffer.destroy(); }
}

/** wall-clock 口径(C2 同款):submit→onSubmittedWorkDone,含 CPU 提交开销,诚实偏大。 */
export async function runFrame(device: GPUDevice, runtime: MegaLightsRuntime,
  resources: { width: number; height: number; lightCount: number; visibilityEnabled?: boolean }, timed: boolean): Promise<number> {
  const encoder = device.createCommandEncoder({ label: "MegaLights probe frame" });
  runtime.encode(encoder, { ...resources, visibilityEnabled: resources.visibilityEnabled ?? false });
  const start = performance.now();
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  return timed ? performance.now() - start : 0;
}

/** 抓 Tint 编译诊断(shader 编译失败在 Chrome 是异步 uncaptured error,dispatch 静默变 no-op)。 */
export async function compilationMessages(runtime: MegaLightsRuntime): Promise<string[]> {
  const info = await runtime.shaderModule.getCompilationInfo();
  return info.messages.map(message => `${message.type}:${message.lineNum}:${message.message}`);
}
