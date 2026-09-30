/**
 * I 级 C1 3DGS——GPU 资源合同骨架:quad 顶点、record 缓冲、uniform 布局。
 *
 * 首刀路径:instanced triangle-strip quad(4 顶点 × 实例数)+
 * storage array<vec4f> records(records 即解码产物原缓冲,GPU 直传零拷贝语义)+
 * 176B uniform(view/viewProjection/camera/viewport/focal/controls)。
 * 排序在 CPU(sortSplatsByDepth),索引序决定 instance 顺序——首刀
 * 不做 GPU radix,不做 indirect;真机渲染未测量(见交付报告 unmeasured 留项)。
 */
import {
  SPLAT_RECORD_FLOAT_STRIDE,
  SPLAT_MAX_SPLAT_COUNT,
  SplatParseError,
} from "./splatFormatContract.js";

/** instance 画 4 顶点 triangle-strip,角落单位为 σ(着色器内 -2..2)。 */
export const SPLAT_QUAD_CORNER_COUNT = 4;
/** uniform 浮点数:view(16) + viewProjection(16) + camera(4) + viewportFocal(4) + controls(4)。 */
export const SPLAT_UNIFORM_FLOAT_COUNT = 44;
export const SPLAT_UNIFORM_BYTE_LENGTH = SPLAT_UNIFORM_FLOAT_COUNT * 4;
/** alpha 截止:低于此值的高斯尾不产生片元,与深度写入关闭配合避免排序噪点。 */
export const SPLAT_ALPHA_CUTOFF = 1 / 255;
/** EWA 投影后 2D 协方差的膨胀补偿(px²),canonical 3DGS low-pass 值。 */
export const SPLAT_COVARIANCE_PAD_PX2 = 0.3;

export interface SplatFrameUniforms {
  /** 列主序 view 矩阵(16)。 */
  viewMatrix: ArrayLike<number>;
  /** 列主序 viewProjection 矩阵(16)。 */
  viewProjectionMatrix: ArrayLike<number>;
  /** 世界系相机位置。 */
  cameraPosition: readonly [number, number, number];
  /** 渲染目标像素尺寸。 */
  viewportPixels: readonly [number, number];
  /** 焦距(像素),fx/fy;无标定时用 viewport×0.5/tan(fov/2) 自行换算后传入。 */
  focalPixels: readonly [number, number];
  /** 每帧排序后的粒数(绘制 instance 数)。 */
  splatCount: number;
  /** Camera near plane; omitted retains the original 0.1 default. */
  near?: number;
}

/** 三条边顺序 + strip 复用两个三角形覆盖 [-2,2]²;着色器按 corner 半径采样。 */
export function createSplatQuadVertexArray(): Float32Array {
  return new Float32Array([-2, -2, 2, -2, -2, 2, 2, 2]);
}

export function splatRecordBufferByteLength(splatCount: number): number {
  return splatCount * SPLAT_RECORD_FLOAT_STRIDE * 4;
}

/** 越帧预算门:绘制入口统一断言,防止把整云误挂进多 slot 重复画。 */
export function assertSplatFrameBudget(splatCount: number): void {
  if (!Number.isSafeInteger(splatCount) || splatCount < 0 || splatCount > SPLAT_MAX_SPLAT_COUNT) {
    throw new SplatParseError(
      `Splat frame instance count ${splatCount} is invalid or exceeds the ${SPLAT_MAX_SPLAT_COUNT} budget.`);
  }
}

/** 写入 176B uniform(WGSL SplatFrameParams 逐字段列主序;纯函数可单测)。 */
export function writeSplatUniforms(target: Float32Array, uniforms: SplatFrameUniforms): void {
  if (target.length !== SPLAT_UNIFORM_FLOAT_COUNT) {
    throw new SplatParseError(
      `Splat uniform target must hold ${SPLAT_UNIFORM_FLOAT_COUNT} floats, received ${target.length}.`);
  }
  // ArrayLike<number> 无法保证底层是 f32 视图,显式逐元素写入(列主序原样)。
  for (let index = 0; index < 16; index++) target[index] = uniforms.viewMatrix[index]!;
  for (let index = 0; index < 16; index++) target[16 + index] = uniforms.viewProjectionMatrix[index]!;
  target[32] = uniforms.cameraPosition[0];
  target[33] = uniforms.cameraPosition[1];
  target[34] = uniforms.cameraPosition[2];
  target[35] = 0; // padding
  target[36] = uniforms.viewportPixels[0];
  target[37] = uniforms.viewportPixels[1];
  target[38] = uniforms.focalPixels[0];
  target[39] = uniforms.focalPixels[1];
  target[40] = uniforms.splatCount;
  target[41] = SPLAT_ALPHA_CUTOFF;
  target[42] = SPLAT_COVARIANCE_PAD_PX2;
  target[43] = uniforms.near ?? 0.1;
}

export interface SplatGpuResources {
  /** STORAGE | COPY_DST,内容 = cloud.records 原样 64B/粒。 */
  recordBuffer: GPUBuffer;
  recordBufferByteLength: number;
  /** VERTEX | COPY_DST,4 角点 × vec2。 */
  quadBuffer: GPUBuffer;
  /** UNIFORM | COPY_DST,SPLAT_UNIFORM_BYTE_LENGTH。 */
  uniformBuffer: GPUBuffer;
  instanceCount: number;
}

/**
 * 唯一触达 GPUDevice 的函数(资源创建,无 pass 编码;编码侧由后续接线)。
 * 真机分配未测量——无 GPU 会话环境,仅在合同层锁定 usage 与尺寸。
 */
export function createSplatGpuResources(device: GPUDevice, records: Float32Array, splatCount: number): SplatGpuResources {
  assertSplatFrameBudget(splatCount);
  const recordByteLength = splatRecordBufferByteLength(splatCount);
  const recordBuffer = device.createBuffer({
    size: Math.max(recordByteLength, 4),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(recordBuffer, 0, records as Float32Array<ArrayBuffer>);
  const quadBuffer = device.createBuffer({
    size: SPLAT_QUAD_CORNER_COUNT * 2 * 4,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(quadBuffer, 0, createSplatQuadVertexArray() as Float32Array<ArrayBuffer>);
  const uniformBuffer = device.createBuffer({
    size: SPLAT_UNIFORM_BYTE_LENGTH,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  return { recordBuffer, recordBufferByteLength: recordByteLength, quadBuffer, uniformBuffer, instanceCount: splatCount };
}
