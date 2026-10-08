/// <reference types="@webgpu/types" />
/**
 * M2 方向光 RT 阴影帧资源管理器(features.rayTracedShadows 的渲染器侧供给)。
 *
 * == 合同(对照 rayTracing/shadowRayFramePass,只消费其公开 API,不改 rayTracing/) ==
 * - mask 纹理:r32float,STORAGE_BINDING(kernel texture_storage_2d write)|TEXTURE_BINDING
 *   (直接光 group(2) binding(3) 采样)|COPY_SRC(验收 readback),内部分辨率;
 *   resize 时销毁重建,view 经 maskView 供给 CascadedShadowResources 第 4 条绑定;
 * - ShadowRayFramePass:场景缓冲构造期一次上传;场景替换走 updateTlasRegion 增量
 *   (BLAS 段计数变化即整体重建 pass);f16 档缺 shader-f16 构造即抛(fail-closed);
 * - encodeFrameValidated(context):生产同步编码，必须早于 encoder.finish；encodeFrame
 *   保留探针等待 validation 的异步入口。主帧 depth(depth32float,depth-only 2d 视图)重建
 *   着色点,沿光源方向发射两级遮挡射线写 mask——必须在直接光 pass 之前、同一 encoder
 *   上调用(帧接线钩子合同见 docs/handoffs/rt-frame-hook-handoff.md;深度为上一已提交
 *   帧内容,mask 恒一帧延迟,与 TAA 抖动序列同构);
 * - 开关位闭环:frame.output.bloom(pbrFrameUniforms 打包,1=采样 mask)。构造期降级
 *   (f16 缺失/WGSL 校验失败/场景未供给)由 disabled 披露,宿主将 features 快照回退为
 *   rayTracedShadows=false —— RT 变体管线的分支不进入,占位 1×1 mask(值 1.0)保证
 *   即便误进分支也无黑影,行为严格等于级联档。
 */
import { ShadowRayFramePass } from "../rayTracing/shadowRayFramePass.js";
import type { TlasPackedScene } from "../rayTracing/tlasLayout.js";
import type { DeviceSession } from "./deviceSession.js";

const MASK_FORMAT: GPUTextureFormat = "r32float";
// GPUTextureUsage.COPY_SRC|COPY_DST|TEXTURE_BINDING|STORAGE_BINDING = 0x01|0x02|0x04|0x08
// (数字字面量避开模块顶层 GPU* 全局求值 —— node 消费链无 WebGPU 全局,同 shadowRayFramePass
// 先例)。COPY_DST 为占位 mask 的 writeTexture 必需(2026-10-06 真机收口:缺失即
// uncaptured validation error → DeviceSession.hasErrors,帧循环 fail)。
const MASK_USAGE = 0x01 | 0x02 | 0x04 | 0x08;
/** 全实例射线掩码(与 TLAS 实例 mask 按位与;0xffffffff = 不按掩码跳过)。 */
const DEFAULT_RAY_MASK = 0xffffffff;

export interface RtShadowFrameControllerOptions {
  /** f16 压缩节点档(需 device.features "shader-f16";默认 false)。 */
  readonly f16?: boolean;
  /** 遮挡射线最大距离(世界单位;缺省 = extent × 8,与主阴影正交覆盖同量级)。 */
  readonly tMax?: number;
}

export interface RtShadowFrameEncodeContext {
  readonly encoder: GPUCommandEncoder;
  readonly width: number;
  readonly height: number;
  /** 主帧 hardware depth(depth32float;本帧主 pass 即将重写,本 dispatch 读上一帧内容)。 */
  readonly depthTexture: GPUTexture;
  /** 内部主帧 viewProjection(带 TAA 抖动,与产生 depth 的 pass 同源;列主序 16 f32)。 */
  readonly viewProjection: Float32Array;
  /** 单位化指向光方向(世界空间;与 frame.lightDirection 同源)。 */
  readonly lightDirection: readonly [number, number, number];
  /** 场景尺度(view.extent;tMax 缺省派生基准)。 */
  readonly extent: number;
  readonly rayMask?: number;
}

export interface RtShadowFrameDispatchResult {
  readonly dispatchX: number;
  readonly dispatchY: number;
}

export type RtShadowFrameDisabled = Readonly<{ disabled: true; reason: string }>;

/** 列主序 4×4 求逆(与 cameraMath 的 lookAt/perspective 布局一致;行列式近零即抛)。 */
export function invertColumnMajor4x4(m: ArrayLike<number>): Float32Array<ArrayBuffer> {
  const a00 = m[0]!, a01 = m[1]!, a02 = m[2]!, a03 = m[3]!;
  const a10 = m[4]!, a11 = m[5]!, a12 = m[6]!, a13 = m[7]!;
  const a20 = m[8]!, a21 = m[9]!, a22 = m[10]!, a23 = m[11]!;
  const a30 = m[12]!, a31 = m[13]!, a32 = m[14]!, a33 = m[15]!;
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) throw new Error("RT shadow invViewProjection: singular matrix.");
  det = 1 / det;
  const out = new Float32Array(16);
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}

export class RtShadowFrameController {
  /** fail-closed 状态:true = 本会话不再产生 RT dispatch(宿主应把 features 快照的
   *  rayTracedShadows 位清 0,WGSL 分支不进入回级联;maskView 仍合法供给绑定)。 */
  disabled: RtShadowFrameDisabled | undefined;
  private pass: ShadowRayFramePass | undefined;
  private maskTexture: GPUTexture | undefined;
  private maskView_: GPUTextureView | undefined;
  private depthViewFor: GPUTexture | undefined;
  private depthView: GPUTextureView | undefined;
  private width = 0;
  private height = 0;
  private sceneCommitted = false;
  private disposed = false;

  constructor(private readonly session: DeviceSession, private readonly options: RtShadowFrameControllerOptions = {}) {
    // 占位 1×1 mask(值 1.0=可见):group(2) 第 4 条绑定在首次真实 dispatch 前有合法
    // 资源;开关位默认 0,即便分支误进也不产生黑影(fail-closed 方向)。与级联资源
    // 同 fatal 语义 —— 1×1 纹理分配失败即构造抛错(device 已不可用,渲染器无法继续)。
    this.ensureMask(1, 1);
    const staging = new Float32Array([1]);
    this.session.device.queue.writeTexture({ texture: this.maskTexture! }, staging,
      { bytesPerRow: 4, rowsPerImage: 1 }, [1, 1]);
  }

  get maskView(): GPUTextureView { return this.maskView_!; }
  get sceneStaged(): boolean { return this.sceneCommitted; }
  get ready(): boolean { return this.pass?.ready === true; }
  /** mask 视图代次(ensureMask 重建即 +1;帧宿主按差分把新视图换装进 shadowState)。 */
  maskViewEpoch = 0;
  /** 当前已staging的 TLAS 打包场景(RT 反射通道场景复用;未 staging 为 undefined)。 */
  get packedScene(): import("../rayTracing/tlasLayout.js").TlasPackedScene | undefined { return this.pass?.packed; }

  /** 调用方供给 TLAS 打包场景(BLAS 段计数变化整体重建 pass,否则增量 TLAS)。 */
  stageScene(packed: TlasPackedScene): void {
    this.assertUsable("stageScene");
    try {
      if (this.pass && this.pass.packed.blasNodeCount === packed.blasNodeCount
        && this.pass.packed.triangleCount === packed.triangleCount) {
        this.pass.updateTlasRegion(packed);
        this.sceneCommitted = true;
        return;
      }
      this.pass?.destroy();
      this.pass = new ShadowRayFramePass(this.session.device, packed, { f16: this.options.f16 === true });
      this.sceneCommitted = true;
    } catch (error) {
      // f16 缺 shader-f16 / WGSL 校验失败 / 超 maxInstances:fail-closed 降级,不阻塞渲染循环。
      this.pass = undefined;
      this.sceneCommitted = false;
      this.disabled = { disabled: true, reason: `ShadowRayFramePass staging failed: ${(error as Error).message}` };
    }
  }

  /** 内部分辨率变化时重建 mask(帧钩子在 encoder 创建后、直接光 pass 前调用)。 */
  ensureSurface(width: number, height: number): void {
    this.assertUsable("ensureSurface");
    if (this.width === width && this.height === height) return;
    this.ensureMask(width, height);
    this.width = width;
    this.height = height;
  }

  /**
   * 帧内联 dispatch(同一 encoder,先于直接光绘制;深度为上一已提交帧内容)。
   * 返回 undefined = 本帧未产生 GPU 工作(pass 未就绪/已降级,调用方按开关位回退级联)。
   */
  async encodeFrame(context: RtShadowFrameEncodeContext): Promise<RtShadowFrameDispatchResult | undefined> {
    await this.pass?.waitUntilReady();
    return this.encodeFrameValidated(context);
  }

  /** Frame owner must call this synchronously before encoder.finish(). */
  encodeFrameValidated(context: RtShadowFrameEncodeContext): RtShadowFrameDispatchResult | undefined {
    const pass = this.pass;
    if (this.disabled || !pass || !this.sceneCommitted) return undefined;
    if (pass.validationFailure) { this.disabled = { disabled: true, reason: pass.validationFailure.message }; return undefined; }
    if (!pass.ready) return undefined;
    if (this.width !== context.width || this.height !== context.height) return undefined;
    if (context.depthTexture !== this.depthViewFor) {
      this.depthView = context.depthTexture.createView({ dimension: "2d", aspect: "depth-only" });
      this.depthViewFor = context.depthTexture;
    }
    const tMax = this.options.tMax ?? context.extent * 8;
    const inv = invertColumnMajor4x4(context.viewProjection);
    return pass.encodeValidated(context.encoder, {
      depthView: this.depthView!, maskView: this.maskView!, width: context.width, height: context.height,
      invViewProjection: [inv[0]!, inv[1]!, inv[2]!, inv[3]!, inv[4]!, inv[5]!, inv[6]!, inv[7]!,
        inv[8]!, inv[9]!, inv[10]!, inv[11]!, inv[12]!, inv[13]!, inv[14]!, inv[15]!],
      lightDir: context.lightDirection, tMax, rayMask: context.rayMask ?? DEFAULT_RAY_MASK,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pass?.destroy();
    this.pass = undefined;
    this.maskTexture?.destroy();
    this.maskTexture = undefined;
    this.maskView_ = undefined;
    this.depthView = undefined;
    this.depthViewFor = undefined;
  }

  private ensureMask(width: number, height: number): void {
    if (this.maskTexture?.width === width && this.maskTexture?.height === height) return;
    this.maskTexture?.destroy();
    const texture = this.session.device.createTexture({
      label: "deep-rt-shadow-mask", size: [width, height], format: MASK_FORMAT,
      usage: MASK_USAGE,
    });
    this.maskTexture = texture;
    this.maskView_ = texture.createView({ dimension: "2d" });
    this.maskViewEpoch += 1;
  }

  private assertUsable(operation: string): void {
    if (this.disposed) throw new Error(`RtShadowFrameController is disposed (${operation}).`);
    if (this.disabled) throw new Error(`RtShadowFrameController is disabled (${this.disabled.reason}); ${operation} refused.`);
  }
}
