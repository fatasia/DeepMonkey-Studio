/// <reference types="@webgpu/types" />
import type { DeviceSession } from "../webgpu/deviceSession.js";

/**
 * Brief-GI M2 验收读回(真机探针/奇偶性对拍):storage 缓冲 → Float32Array 快照。
 * 独立小模块守主运行时 300 行体量门;usage 用规范数值常量(stub 环境无 GPU 全局,
 * shadowRayPass.ts 同款先例)。
 */

const USAGE_COPY_DST = 0x8;
const USAGE_MAP_READ = 0x1;
/** GPUMapMode.READ 的规范数值(stub 环境安全)。 */
export const GPU_MAP_MODE_READ = 0x1;

/** copy → mapAsync → 拷贝出可持有副本 → 销毁暂存(自持生命周期,不占 session 账)。 */
export async function readbackStorageBuffer(session: DeviceSession,
  buffer: GPUBuffer): Promise<Float32Array<ArrayBuffer>> {
  const device = session.device;
  const staging = device.createBuffer({ label: "Deep SDF GI readback", size: buffer.size,
    usage: USAGE_COPY_DST | USAGE_MAP_READ });
  try {
    const encoder = device.createCommandEncoder({ label: "Deep SDF GI readback" });
    encoder.copyBufferToBuffer(buffer, 0, staging, 0, buffer.size);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPU_MAP_MODE_READ);
    return new Float32Array(staging.getMappedRange().slice(0));
  } finally {
    staging.unmap();
    staging.destroy();
  }
}
