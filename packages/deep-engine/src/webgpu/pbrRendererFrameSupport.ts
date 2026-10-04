//! PBR 帧编排辅助(自 pbrRendererFrames.ts 迁出:capture/分配计划、指标采样、
//! 虚拟纹理推进、VSM 物化输入、帧校验)。函数体逐字未改;公开符号
//! (driveVirtualTextures/validateFrame)由 pbrRendererFrames.ts re-export 保路径。
import type { PbrRendererFrameHost } from "./pbrRendererFrames.js";
import type { CachedPacketGeometry } from "./packetBufferTypes.js";
import { virtualTextureUvBounds, type VirtualTextureFeedbackEntry,
  type VirtualTextureFrameMetrics } from "./virtualTextureFrameBridge.js";
import type { VirtualShadowDynamicInput, VirtualShadowObjectInput } from "../shadows/virtualShadowPages.js";
import { internalResolutionReport } from "../postprocess/resolutionScaler.js";
import { buildPbrFrameExecutionPlan, collectActualPbrFramePasses, assertPlanMatchesActual,
  pbrFramePassTimingsUnavailable } from "./pbrFramePlanExecutor.js";
import type { PbrFramePassTimings } from "./pbrFrameReceipt.js";
import { resolvePbrPostProcessOverrides } from "./pbrPostProcessOverrides.js";
import type { PbrRendererFeatures } from "./pbrRendererFeatures.js";
import { compilePbrFrameGraph } from "./pbrFrameGraph.js";
import type { RenderGraphCompileResult } from "../renderGraph.js";
import { validatePbrFrame } from "./validatePbrFrame.js";
import type { FrameMetrics, RenderView } from "./pbrRendererTypes.js";
import type { updatePbrFrameUniforms } from "./pbrFrameUniforms.js";

/** batch 球体 → 屏幕圆盘像素面积(静态代理):focal = height/2 / tan(fov/2),
 *  透视深取 clip w;w≤0 或 NDC z 出 [0,1](WebGPU 口径)显式 0 = 不产反馈。 */
function virtualTextureScreenPixels(geometry: CachedPacketGeometry, viewProjection: Float32Array,
  verticalFovRadians: number, size: { readonly width: number; readonly height: number }): number {
  const [cx, cy, cz] = geometry.center;
  const w = viewProjection[3]! * cx + viewProjection[7]! * cy + viewProjection[11]! * cz + viewProjection[15]!;
  if (!(w > 0)) return 0;
  const z = viewProjection[2]! * cx + viewProjection[6]! * cy + viewProjection[10]! * cz + viewProjection[14]!;
  if (z < 0 || z > w) return 0;
  const focal = size.height / (2 * Math.tan(verticalFovRadians / 2));
  const radiusPx = geometry.radius * focal / w;
  return Math.PI * radiusPx * radiusPx;
}

  /** F4 虚拟纹理逐帧推进:batch 级反馈代理 → 预算驻留 → tile-lookup 消费编码。
   *  fallback/atlas 未就绪时跳过消费编码,遥测仍逐帧回报(fail-closed,不静默)。 */
export function driveVirtualTextures(host: PbrRendererFrameHost, frameState: ReturnType<typeof updatePbrFrameUniforms>,
    size: { readonly width: number; readonly height: number }, encoder: GPUCommandEncoder):
    VirtualTextureFrameMetrics | undefined {
    const bridge = host.virtualTextures!;
    const metrics = bridge.observeFrame(collectVirtualTextureFeedback(host, frameState, size));
    const atlas = bridge.atlasTexture;
    if (atlas === undefined || bridge.fallbackActive) return metrics;
    const lookup = host.virtualTileLookup!;
    const sampled = lookup.encode(encoder, { atlasView: lookup.viewOf(atlas),
      atlasEdge: bridge.atlasEdgeTexels, catalog: bridge.textureCatalog(),
      layerOfPage: (textureId, tileX, tileY, mip) => bridge.layerOfPage(textureId, tileX, tileY, mip),
      packing: bridge.packPageTable(),
      samples: bridge.samples });
    return { ...metrics, sampling: { dispatches: sampled.dispatches, samples: sampled.samples,
      skipped: sampled.skipped } };
  }

  /** batch 级反馈条目:材质纹理槽 × UV 仿射包围域 × 球盘投影屏幕像素×实例数。
   *  静态代理口径(同 autoExposure 先例):不新增 GPU 往返;不做逐实例精确视锥剔除
   *  (背向/越远裁剪由 w≤0 与 NDC z 出界剔除),覆盖高估由反馈读取器 tile 聚合兜底。 */
function collectVirtualTextureFeedback(host: PbrRendererFrameHost, frameState: ReturnType<typeof updatePbrFrameUniforms>,
    size: { readonly width: number; readonly height: number }): VirtualTextureFeedbackEntry[] {    const inputs = host.packets.visibilityInputs();
    const entries: VirtualTextureFeedbackEntry[] = [];
    for (const batch of inputs.batches.values()) {
      const textures = batch.source.textures;
      if (!textures) continue;
      const geometry = inputs.geometries.get(batch.source.geometry);
      const screenPixels = geometry === undefined ? 0 : virtualTextureScreenPixels(geometry,
        frameState.depthViewProjection, frameState.projection.verticalFovRadians, size) * batch.source.count;
      if (!(screenPixels > 0)) continue;
      for (const slot of [textures.baseColor, textures.metallicRoughness, textures.normal,
        textures.occlusion, textures.emissive]) {
        if (!slot) continue;
        const bounds = virtualTextureUvBounds(slot.uvTransform);
        entries.push({ textureId: slot.texture, ...bounds, screenPixels });
      }
    }
    return entries;
  }

  /**
   * B1 Brief-VSM 物化输入:实例级世界点(从 batch.data 打包行提取,场景修订缓存)→
   * 环投影误差对象。几何局部包围对页物化无意义(整批共享同一 geometry,实例分布
   * 决定页分布);每帧 3 环投影一次,大批按 cap 采样控制 CPU 成本。
   * 动态输入取变形批保守包络(与剔除同源,零额外估算)。
   */
const virtualShadowObjectCache = new WeakMap<object, { revision: number;
    points: Float32Array<ArrayBuffer>; radii: Float32Array<ArrayBuffer> }>();
const VIRTUAL_SHADOW_INSTANCE_STRIDE = 36;
const VIRTUAL_SHADOW_MAX_SAMPLES_PER_BATCH = 4096;
export function collectVirtualShadowObjects(host: PbrRendererFrameHost, frameState: ReturnType<typeof updatePbrFrameUniforms>,
    size: { readonly width: number; readonly height: number }): {
    readonly objects: VirtualShadowObjectInput[];
    readonly dynamic: VirtualShadowDynamicInput[];
  } {
    const inputs = host.packets.visibilityInputs();
    const revision = host.packets.visibilityRevision;
    let cache = virtualShadowObjectCache.get(inputs.batches);
    if (!cache || cache.revision !== revision) {
      const xs: number[] = [], radii: number[] = [];
      for (const batch of inputs.batches.values()) {
        if (batch.source.castShadow === false) continue;
        const geometry = inputs.geometries.get(batch.source.geometry);
        if (!geometry || !batch.source.data) continue;
        const data = batch.source.data, stride = VIRTUAL_SHADOW_INSTANCE_STRIDE;
        const count = Math.min(batch.source.count, VIRTUAL_SHADOW_MAX_SAMPLES_PER_BATCH);
        const step = Math.max(1, batch.source.count / count);
        for (let index = 0; index < batch.source.count; index += step) {
          const base = Math.floor(index) * stride;
          // 行主序仿射:world = row·p;平移 = 行 w 分量;尺度 ≈ 行 xyz 范数最大者。
          const tx = data[base + 3]!, ty = data[base + 7]!, tz = data[base + 11]!;
          const s0 = Math.hypot(data[base]!, data[base + 4]!, data[base + 8]!);
          const s1 = Math.hypot(data[base + 1]!, data[base + 5]!, data[base + 9]!);
          const s2 = Math.hypot(data[base + 2]!, data[base + 6]!, data[base + 10]!);
          xs.push(tx, ty, tz);
          radii.push(Math.max(s0, s1, s2) * geometry.radius);
        }
      }
      cache = { revision, points: Float32Array.from(xs), radii: Float32Array.from(radii) };
      virtualShadowObjectCache.set(inputs.batches, cache);
    }
    const viewProjection = frameState.depthViewProjection;
    const tanHalfFov = Math.tan(frameState.projection.verticalFovRadians / 2);
    const focal = size.height / (2 * tanHalfFov);
    const objects: VirtualShadowObjectInput[] = [];
    for (let index = 0; index < cache.points.length / 3; index++) {
      const x = cache.points[index * 3]!, y = cache.points[index * 3 + 1]!, z = cache.points[index * 3 + 2]!;
      const w = viewProjection[3]! * x + viewProjection[7]! * y + viewProjection[11]! * z + viewProjection[15]!;
      if (!(w > 0)) continue;
      const clipZ = viewProjection[2]! * x + viewProjection[6]! * y + viewProjection[10]! * z + viewProjection[14]!;
      if (clipZ < 0 || clipZ > w) continue;
      const radius = cache.radii[index]!;
      const radiusPx = radius * focal / w;
      objects.push({ x, y, z, radius,
        screenPixels: Math.PI * radiusPx * radiusPx,
        desiredWorldTexel: 2 * w * tanHalfFov / size.height });
    }
    const dynamic: VirtualShadowDynamicInput[] = [];
    for (const envelope of host.packets.dynamicBoundsEnvelope().values()) {
      dynamic.push({ x: envelope.center[0]!, y: envelope.center[1]!, z: envelope.center[2]!,
        radius: envelope.radius });
    }
    return { objects, dynamic };
  }

export function resolutionScaleMetrics(host: PbrRendererFrameHost, surface: { readonly width: number; readonly height: number }): FrameMetrics["resolutionScale"] | undefined {
    if (host.resolutionScaler === undefined || host.resolutionScale === 1) return undefined;
    // 质量槽位保持 measured=false：真实画质数字须来自 GPU 序列联测，不许发明。
    // surface 传画布尺寸:超分激活时 internalWidth/Height 就是真实渲染分辨率。
    return { revision: host.resolutionScaleRevision,
      ...internalResolutionReport(host.resolutionScale, surface.width, surface.height) };
  }

  /** F1:最新完成读回的逐 pass 计时;尚无读回时显式 unavailable,不伪零。 */
export function passTimingsMetrics(host: PbrRendererFrameHost, frameNumber: number): PbrFramePassTimings {
    const latest = host.diagnostics.latestPassTimings;
    if (latest) return latest;
    const reason = !host.gpuTimer.enabled ? "诊断采样未启用,逐 pass GPU 计时未采集"
      : !host.gpuTimer.supported ? "设备不支持 timestamp-query,逐 pass GPU 计时不可用"
        : "等待首个逐 pass GPU 时间戳读回";
    return pbrFramePassTimingsUnavailable(frameNumber, reason);
  }

export function sampleAdaptiveQuality(host: PbrRendererFrameHost, metrics: FrameMetrics): void {
    if (!host.adaptiveQuality) return;
    const snapshot = host.performanceTelemetry.snapshot();
    const cpu = snapshot.stages["frame-encode"], gpu = snapshot.stages["gpu-frame"];
    if (!cpu) return;
    const samples = host.performanceTelemetry.samples("frame-encode");
    host.adaptiveQuality.sample({ frame: metrics.frame, sampleCount: cpu.samples, cpuP95Ms: cpu.p95Ms, cpuP99Ms: cpu.p99Ms,
      ...(gpu ? { gpuP95Ms: gpu.p95Ms, gpuP99Ms: gpu.p99Ms } : {}),
      longFrameCount: samples.filter(value => value > 33.34).length,
      width: metrics.width, height: metrics.height, drawCalls: metrics.drawCalls, triangles: metrics.triangles,
      memory: metrics.deviceResourceMemory ?? host.session.resourceMemory });
  }
export function captureForFrame(host: PbrRendererFrameHost, size: { readonly width: number; readonly height: number }, transparency: boolean,
    postProcess: ReturnType<typeof resolvePbrPostProcessOverrides>, directDisplay: boolean, depthResolved: boolean): {
    readonly plan: ReturnType<typeof buildPbrFrameExecutionPlan>;
    readonly actual: ReturnType<typeof collectActualPbrFramePasses>;
  } {
    // AA-M1:MSAA 通路状态进计划键 —— 回执/对拍声明随主 pass 附件形态切换。
    const msaaMainPass = host.targets.msaaActive && !directDisplay;
    const key = `${size.width}x${size.height}:${transparency ? "transparent" : "opaque"}`
      + `:ao=${postProcess.ambientOcclusion ? 1 : 0}:ssr=${postProcess.screenSpaceReflection ? 1 : 0}`
      + `:fog=${postProcess.volumetricFog ? 1 : 0}:god=${postProcess.volumetricFogProfile.godRaysStrength !== undefined ? 1 : 0}:bloom=${postProcess.bloom ? 1 : 0}:direct=${directDisplay ? 1 : 0}`
      + `:msaa=${msaaMainPass ? host.mainSampleCount : 1}`
      + `:cs=${host.features.contactShadows ? 1 : 0}:up=${host.features.temporalUpscale ? 1 : 0}:hdr=${host.session.hdrCanvasActive ? 1 : 0}`;
    if (host.capturePlanKey !== key || !host.capturePlan || !host.captureActualPasses) {
      const captureFeatures: PbrRendererFeatures = Object.freeze({ ...host.features,
        ambientOcclusion: postProcess.ambientOcclusion,
        screenSpaceReflection: postProcess.screenSpaceReflection,
        volumetricFog: postProcess.volumetricFog,
        bloom: postProcess.bloom,
        spatialAa: host.outputs.spatialAaActive,
      });
      const opaqueColorResource = postProcess.ambientOcclusion ? "ao-hdr" : "opaque-hdr";
      const plan = buildPbrFrameExecutionPlan(size, { transparency, features: captureFeatures,
        godRays: postProcess.volumetricFogProfile.godRaysStrength !== undefined,
        directDisplay, writeGeometryBuffers: host.writeGeometryBuffers, hdrDisplay: host.session.hdrCanvasActive });
      const presentInputResource = host.features.temporalUpscale && !directDisplay ? "upscale-hdr"
        : host.features.contactShadows ? "contact-hdr"
        : postProcess.bloom ? "bloom-hdr"
        : host.features.temporalAa ? "temporal-hdr" : postProcess.screenSpaceReflection ? "ssr-hdr"
          : postProcess.volumetricFog ? "volumetric-fog-hdr"
          : transparency ? "composited-hdr" : opaqueColorResource;
      const actual = collectActualPbrFramePasses(captureFeatures, transparency,
        { opaqueColorResource, presentInputResource, directDisplay, writeGeometryBuffers: host.writeGeometryBuffers,
          godRays: postProcess.volumetricFogProfile.godRaysStrength !== undefined,
          bloom: postProcess.bloom, hdrDisplay: host.session.hdrCanvasActive,
          msaa: msaaMainPass, depthResolved: msaaMainPass && depthResolved });
      assertPlanMatchesActual(plan, actual);
      host.capturePlan = plan;
      host.captureActualPasses = actual;
      host.capturePlanKey = key;
    }
    return { plan: host.capturePlan, actual: host.captureActualPasses };
  }
export function allocationPlanFor(host: PbrRendererFrameHost, transparency: boolean,
    postProcess: ReturnType<typeof resolvePbrPostProcessOverrides>, directDisplay: boolean): RenderGraphCompileResult {
    const key = `${transparency ? 1 : 0}:${postProcess.ambientOcclusion ? 1 : 0}:${postProcess.screenSpaceReflection ? 1 : 0}`
      + `:${postProcess.volumetricFog ? 1 : 0}:${postProcess.volumetricFogProfile.godRaysStrength !== undefined ? 1 : 0}:${postProcess.bloom ? 1 : 0}:${directDisplay ? 1 : 0}`;
    if (host.allocationPlanKey !== key || !host.allocationPlan) {
      host.allocationPlan = compilePbrFrameGraph({ transparency, features: { ...host.features,
        ambientOcclusion: postProcess.ambientOcclusion, screenSpaceReflection: postProcess.screenSpaceReflection,
        volumetricFog: postProcess.volumetricFog, bloom: postProcess.bloom }, directDisplay,
        godRays: postProcess.volumetricFogProfile.godRaysStrength !== undefined,
        writeGeometryBuffers: host.writeGeometryBuffers });
      if (!host.allocationPlan.valid) throw new Error("PBR transient allocation graph is invalid.");
      host.allocationPlanKey = key;
    }
    return host.allocationPlan;
  }
export function executedCapturePassIds(host: PbrRendererFrameHost, directClear: boolean, postProcess: ReturnType<typeof resolvePbrPostProcessOverrides>,
    transparency: boolean, upscaling: boolean): ReadonlySet<string> {
    const ids = new Set<string>(["opaque"]);
    if (directClear) return ids;
    if (postProcess.ambientOcclusion) { ids.add("ambient-occlusion"); ids.add("apply-ambient-occlusion"); }
    if (postProcess.screenSpaceReflection) { ids.add("screen-space-reflection-trace"); ids.add("screen-space-reflection-composite"); }
    if (transparency) { ids.add("transparent-oit"); ids.add("composite-oit"); }
    if (postProcess.volumetricFog) { ids.add("volumetric-fog-march"); ids.add("volumetric-fog-composite"); }
    if (host.features.temporalAa) ids.add("temporal-aa");
    // F4:超分编码门 = 特性位 && 实际降档(encodeUpscale 调用点的同一 upscaling 谓词,
    // 单一真值来源)。执行集若只看特性位,coverage/回执会在"特性开但 scale=1"帧
    // 谎报 temporal-upscale 已执行;此时它如实落入 notExecutedMappedPassIds(合法跳过显式可见)。
    if (host.features.temporalUpscale && upscaling) ids.add("temporal-upscale");
    if (postProcess.bloom) ids.add("bloom");
    ids.add("present");
    return ids;
  }
/** 原类公共方法:帧校验即真实 render 一帧并断言零校验错误。 */
export async function validateFrame(host: PbrRendererFrameHost, view: RenderView): Promise<FrameMetrics> {
  host.deviceEpoch?.assertCurrent(host.session.device);
  return validatePbrFrame(host.session, () => host.render(view), () => {
    host.previousHiZ.invalidate(); host.shadows.invalidate(); host.localShadows.invalidate();
    host.virtualShadows?.invalidate();
    host.shadowDirty = true; host.historyDirty = true;
  });
}
