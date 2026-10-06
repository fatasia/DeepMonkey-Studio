/**
 * B2 MegaLights M2 帧接线决策面(纯函数 + 上下文合同;体量门纪律:生产源 ≤300 行,
 * 与控制器类分文件)。单一真源:帧早段 depth 消费判定(pbrRendererFrames)与
 * encodeFrame 内部路径决策共用 megaLightsFramePlanned → resolveDirectLightingPath,
 * 零第二实现。
 */
import { resolveDirectLightingPath, type DirectLightingPathDecision } from "./megaLights.js";
import type { MegaLightsFrameVisibilityInput } from "./megaLightsRuntime.js";
import type { ClusteredLights } from "./types.js";

/** 控制器构造选项。 */
export interface MegaLightsFrameControllerOptions {
  /** 显式强制 RIS 路径(≤64 盏也可,退化对拍/验收⑤ 同语义;缺省 false=纯阈值决策)。 */
  readonly forceMegaLights?: boolean;
  /** 空间复用开关(缺省 true,与 M1 验收档一致;单帧方差诊断可关)。 */
  readonly spatialReuse?: boolean;
}

/** encodeFrame 上下文(灯为**视空间**,由调用方 transformWorldLightsToView 产出)。 */
export interface MegaLightsFrameEncodeContext {
  readonly encoder: GPUCommandEncoder;
  readonly width: number;
  readonly height: number;
  /** 加性合成目标(主帧 1x HDR 视图,rgba16float;loadOp load,one+one 混合)。 */
  readonly colorView: GPUTextureView;
  /** 本帧 1x 主帧深度(depth32float;主 pass 与 depth resolve 之后)。 */
  readonly depthTexture: GPUTexture;
  /** 主帧 depthViewProjection(列主序 16 f32;与产生 depth 的 pass 同源)。 */
  readonly depthViewProjection: Float32Array;
  /** 世界→视矩阵(列主序 16 f32;与灯变换同源)。 */
  readonly worldToView: Float32Array;
  /**
   * M2 胜者可见性射线供给(2026-10-05 生产帧 TLAS 收口;缺省 = fail-closed,可见性
   * 恒 1 = 旧行为)。场景复用 RT 阴影 staging 通道的世界空间两级 TLAS(同
   * packTlasScene 形,traceTwoLevelOccluded 同族);调用方负责从 rtShadows.packedScene
   * 取已 staging 场景,未 staging 时不带本字段并经 visibilitySource 披露。
   */
  readonly visibility?: MegaLightsFrameVisibilityInput;
  /** 视空间灯(megaLights.megaLightsFromClustered 消费口径)。 */
  readonly lights: ClusteredLights;
}

export interface MegaLightsFrameResult {
  readonly dispatched: boolean;
  /** 决策依据(词汇与 DirectLightingPathDecision.reason 封闭集一致)。 */
  readonly reason: DirectLightingPathDecision["reason"];
  readonly localLightCount: number;
  readonly areaCount: number;
}

/** 胜者可见性射线供给来源(封闭词汇;off/unsupported = fail-closed,可见性恒 1)。 */
export type MegaLightsVisibilitySource = "off" | "rt-shadow-tlas" | "unsupported";

export interface MegaLightsFrameMetrics {
  readonly dispatchedFrames: number;
  readonly lastLightCount: number;
  readonly lastReason: DirectLightingPathDecision["reason"];
  readonly lastDispatchGroupsX: number;
  readonly lastDispatchGroupsY: number;
  /**
   * 最近一次 encodeFrame 的胜者可见性射线来源:rt-shadow-tlas = RT 阴影 staging 通道
   * 供给且本帧 trace dispatch;off = 本帧无供给(可见性恒 1 = 旧行为;原因查
   * rayTracedShadowStatus:rtShadows 未构造 = features 关,sceneStaged=false = 场景未
   * staging);unsupported = 可见性档运行时构建失败(fail-closed,不重试)。
   */
  readonly visibilitySource: MegaLightsVisibilitySource;
  /** fail-closed 原因(visibilitySource = unsupported 时如实披露;供给成功帧缺省)。 */
  readonly visibilityFallbackReason?: string;
}

/** 帧早段决策纯函数(depth 消费判定与 encodeFrame 决策单一同源,零重复实现)。
 * lights 参数取结构最小形状(WorldClusteredLights / ClusteredLights 两族皆兼容)。 */
export function megaLightsFramePlanned(featureEnabled: boolean,
  lights: { readonly points?: readonly unknown[]; readonly spots?: readonly unknown[] } | undefined,
  forceMegaLights = false): boolean {
  if (!featureEnabled) return false;
  const points = lights?.points?.length ?? 0;
  const spots = lights?.spots?.length ?? 0;
  return resolveDirectLightingPath({ points, spots, forceMegaLights }).path === "megalights-ris";
}

/** 列主序 4×4 乘法(out = a×b;组合 worldToView×invViewProjection 专用)。 */
export function multiplyColumnMajor4x4(a: ArrayLike<number>, b: ArrayLike<number>): Float32Array<ArrayBuffer> {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      out[column * 4 + row] = a[row]! * b[column * 4]! + a[4 + row]! * b[column * 4 + 1]!
        + a[8 + row]! * b[column * 4 + 2]! + a[12 + row]! * b[column * 4 + 3]!;
    }
  }
  return out;
}
