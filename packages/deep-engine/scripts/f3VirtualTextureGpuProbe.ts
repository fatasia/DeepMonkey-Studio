/// <reference types="@webgpu/types" />
// F3/T06 虚拟纹理真机证据 probe(在 headless Chrome 页面内执行;runner: f3VirtualTextureGpuTest.mjs,
// 骨架同 clothParallelGpuTest.mjs:esbuild bundle → 本地 http → playwright + --enable-unsafe-webgpu)。
//
// 四项证据(估时表 F3/T06 行,底座 7e271afe/beacb6a2):
//   a. SSIM≥0.99:虚拟纹理 tile-lookup 路径 vs 等价全量纹理基线,1920×1080 冻结尺寸,双图 SSIM;
//   b. 相机 A→B→A 往返:终态页集与输出与初始逐位一致;
//   c. 预算恢复:超预算压力→回收→解除→页集恢复服务;
//   d. 取消泄漏:中途取消进行中的上传/反馈,引擎+session 资源计数归零。
//
// 纪律:帧时类测量本批禁测(并行负载),本 probe 只做正确性/一致性读回;门限不降(SSIM 0.99 原口径)。
// 相机代理口径:pbrRenderer.collectVirtualTextureFeedback 为渲染器私有,不复制以免合同分叉;
// probe 以文档化代理条目(可见 tile 集 × 屏幕像素)驱动生产反馈读取器→页表→驻留→采样全链。
// 读回 harness 说明:生产 VirtualTextureTileLookupPass 的 out buffer 为私有、产品帧零 readback;
// 联测读回按其注释口径使用【同一份生产 WGSL(VIRTUAL_TEXTURE_TILE_LOOKUP_WGSL)+ 同一 bridge 打包
// 页表(packPageTable)+ 同一 atlas 视图 + 同一样本布局】自持缓冲读回,不修改任何生产语义。
//
// sourceSizeGate 拆分(2026-10-03):按职责分文件,代码逐行同源仅改可见性,语义零变化;
// 本文件保留 runner 合同入口(probeAdapterInfo / runF3Item / F3LegOutcome):
//   会话与驱动 → f3VirtualTextureGpuProbeSession.ts;
//   读回 harness → f3VirtualTextureGpuProbeReadback.ts;
//   度量 → f3VirtualTextureGpuProbeMetrics.ts;
//   证据腿 → f3VirtualTextureGpuProbeLegs.ts。
import { openF3Session } from "./f3VirtualTextureGpuProbeSession.js";
import { legSsim, legCameraRoundTrip, legBudgetRecovery, legCancellationLeak } from "./f3VirtualTextureGpuProbeLegs.js";

export interface F3LegOutcome {
  readonly item: string;
  readonly pass: boolean;
  readonly adapter: unknown;
  readonly deviceErrors: readonly string[];
  readonly result: unknown;
}

// ────────────────────────── 入口 ──────────────────────────

/** runner 冒烟探针:适配器档案(与腿内记录相互印证)。 */
export async function probeAdapterInfo(): Promise<unknown> {
  if (!navigator.gpu) return { unavailable: true };
  const adapter = await navigator.gpu.requestAdapter();
  const info = adapter?.info;
  return info ? { vendor: info.vendor, architecture: info.architecture,
    device: info.device, description: info.description } : { unavailable: true };
}

export async function runF3Item(item: string): Promise<F3LegOutcome> {
  const { session, adapter, deviceErrors } = await openF3Session();
  let disposed = false;
  const disposeOnce = (): void => { if (!disposed) { disposed = true; session.dispose(); } };
  try {
    if (item === "a") {
      const result = await legSsim(session, adapter, deviceErrors);
      return { item, pass: result.pass === true, adapter, deviceErrors, result };
    }
    if (item === "b") {
      const result = await legCameraRoundTrip(session, adapter, deviceErrors);
      return { item, pass: result.pass === true, adapter, deviceErrors, result };
    }
    if (item === "c") {
      const result = await legBudgetRecovery(session, adapter, deviceErrors);
      return { item, pass: result.pass === true, adapter, deviceErrors, result };
    }
    if (item === "d") {
      const result = await legCancellationLeak(session, adapter, deviceErrors);
      return { item, pass: result.pass === true, adapter, deviceErrors, result };
    }
    throw new Error(`unknown F3 item: ${item}`);
  } finally { disposeOnce(); }
}
