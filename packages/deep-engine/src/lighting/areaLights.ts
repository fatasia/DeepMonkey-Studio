import type { LightVector3 } from "./types.js";

/**
 * C3 矩形/带纹理面积光:合同校验、打包 ABI 与语义表(仅 lighting 域内)。
 *
 * 着色数学在 ltc.ts(密度拟合)与 wgsl/ltcAreaLighting.wgsl(GPU 真源);
 * 本文件只做「灯进 GPU」的等价变换与合同闸(沿 clusterPacking/iesShading 家族模式)。
 *
 * 物理口径(与既有点/聚光同域但语义不同,故单列):
 *  - emitted radiance = color × intensity(辐射亮度乘子);远场小面光 ≈
 *    intensity×area 的点光(立体角自然衰减,无 inverse-square decay 字段)。
 *  - range = 硬截断窗口(同点光 range=0 无窗口);decay 无意义(立体角内建)。
 *  - texture = 单共享 cookie 纹理 + 每灯 UV 窗口(绑定 14/15,缺省 1×1 白纹理)。
 */

/**
 * 面光数量合同上限;buffer 按上限常驻分配(F7b 局部阴影 uniform 同款预算纪律)。
 * B2 MegaLights(M1):8→64 扩容与 RIS 采样同批交付——既有簇光是逐灯着色,裸扩 64 盏
 * = 每像素循环成本 ↑8×,帧时爆炸;RIS 通路(每像素 K=32 候选)把逐灯循环换成常数采样,
 * 二者不可拆(任务书 ue-class-b2-task-briefs-20261004.md「扩容禁独立交付」定案)。
 * LUT 区(64×64×2)与灯数无关,只灯区 48→384 vec4(6KB)。
 */
export const MAX_AREA_LIGHTS = 64;
/** 每灯 6 vec4(96B):布局见 packAreaLights 的语义表注释(与 WGSL 逐字对应)。 */
export const AREA_LIGHT_STRIDE_VEC4 = 6;
/** 组合 buffer 字节布局 = [灯区 MAX×6 vec4][LUT 区 64×64×2 vec4]。 */
export const AREA_LIGHT_DATA_VEC4S = MAX_AREA_LIGHTS * AREA_LIGHT_STRIDE_VEC4;
export const AREA_LIGHT_LUT_VEC4S = 64 * 64 * 2;
export const AREA_LIGHT_DATA_VEC4_TOTAL = AREA_LIGHT_DATA_VEC4S + AREA_LIGHT_LUT_VEC4S;

/** 面光 cookie(光斑)纹理窗口:u/v 各自 scale+offset,采样 = window∘切平面投影。 */
export interface AreaLightTextureWindow {
  readonly uvScale: readonly [number, number];
  readonly uvOffset: readonly [number, number];
}

/** 视空间矩形面光(权威运行时合同,与 PointLight/SpotLight 同域)。 */
export interface AreaLight {
  /** 矩形中心,视空间。 */
  readonly positionView: LightVector3;
  /** 发射面法线(单面=只朝此侧发光),打包时归一化。 */
  readonly directionView: LightVector3;
  /** 宽度轴(与 directionView 不平行即可,打包时正交归一)。 */
  readonly upView: LightVector3;
  /** 半宽(up 方向)/半高(bitangent 方向),正有限。 */
  readonly halfExtent: readonly [number, number];
  /** 硬截断半径;0 = 无窗口。 */
  readonly range: number;
  readonly color: LightVector3;
  /** 辐射亮度乘子(见模块头物理口径)。 */
  readonly intensity: number;
  /** 双面发光;缺省单面。 */
  readonly twoSided?: boolean;
  /** 可选光斑窗口;缺省均匀发射。 */
  readonly texture?: AreaLightTextureWindow;
}

/** flags 编码(bit0=twoSided,bit1=texture);与 WGSL DEEP_AREA_LIGHT_FLAGS 同式。 */
export const AREA_LIGHT_FLAG_TWO_SIDED = 1;
export const AREA_LIGHT_FLAG_TEXTURE = 2;

function finite3(value: LightVector3, name: string): void {
  if (value.length !== 3 || !value.every(Number.isFinite)) throw new Error(`${name} must contain three finite values.`);
}

function positiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be finite and positive.`);
}

/** 逐灯合同校验(fail-closed);数量上限由调用方 packAreaLights 强制。 */
export function validateAreaLight(light: AreaLight, name: string): void {
  finite3(light.positionView, `${name}.positionView`);
  finite3(light.directionView, `${name}.directionView`);
  finite3(light.upView, `${name}.upView`);
  if (Math.hypot(...light.directionView) < 1e-8) throw new Error(`${name}.directionView must be nonzero.`);
  if (Math.hypot(...light.upView) < 1e-8) throw new Error(`${name}.upView must be nonzero.`);
  const [halfWidth, halfHeight] = light.halfExtent;
  positiveFinite(halfWidth, `${name}.halfExtent[0]`);
  positiveFinite(halfHeight, `${name}.halfExtent[1]`);
  if (!Number.isFinite(light.range) || light.range < 0) throw new Error(`${name}.range must be finite and nonnegative.`);
  finite3(light.color, `${name}.color`);
  if (light.color.some(component => component < 0)) throw new Error(`${name}.color must be nonnegative.`);
  if (!Number.isFinite(light.intensity) || light.intensity < 0) throw new Error(`${name}.intensity must be finite and nonnegative.`);
  if (light.texture !== undefined) {
    const { uvScale, uvOffset } = light.texture;
    if (uvScale.length !== 2 || uvOffset.length !== 2 || !uvScale.every(Number.isFinite) || !uvOffset.every(Number.isFinite)) {
      throw new Error(`${name}.texture windows must be finite vec2 pairs.`);
    }
  }
}

/** 打包方向归一(方向不平行于法线即合法;近平行由 GLSL 侧退化处理兜底)。 */
function orthonormalBasis(normal: LightVector3, up: LightVector3): { readonly direction: LightVector3; readonly up: LightVector3 } {
  const directionLength = Math.hypot(...normal);
  const direction = normal.map(component => component / directionLength) as unknown as LightVector3;
  const upOrthogonal = up.map((component, index) => component - direction[index]! * (up[0]! * direction[0]! + up[1]! * direction[1]! + up[2]! * direction[2]!));
  const upLength = Math.hypot(...upOrthogonal);
  // up 与法线近平行:退化灯打包为最小可见(半宽正)但方向塌缩由着色端清零。
  const safeUp = upLength < 1e-6 ? [0, 1, 0] as const : upOrthogonal.map(component => component / upLength);
  return { direction, up: safeUp as unknown as LightVector3 };
}

export interface PackedAreaLights {
  /** [灯区(常驻 MAX×6 vec4)][LUT 区(由 clusterCompute 一次写入)]的灯区半区。 */
  readonly lights: Float32Array;
  readonly count: number;
}

/**
 * 打包进固定容量灯区(96B/灯,尾部灯槽清零=着色端 count 截断,字节稳定可 diff)。
 * 布局(语义表,与 WGSL DEEP_AREA_LIGHT_ABI 逐字对应):
 *  [0] positionView.xyz, range
 *  [1] direction.xyz, decay 槽位(恒 0,保留)
 *  [2] up.xyz, flags(bit0 twoSided / bit1 texture)
 *  [3] halfWidth, halfHeight, uvScale.x, uvScale.y
 *  [4] uvOffset.x, uvOffset.y, reserved0, reserved1
 *  [5] radiance.xyz(color×intensity), reserved
 */
export function packAreaLights(lights: readonly AreaLight[]): PackedAreaLights {
  if (lights.length > MAX_AREA_LIGHTS) throw new Error(`Area light count exceeds ${MAX_AREA_LIGHTS}.`);
  const packed = new Float32Array(MAX_AREA_LIGHTS * AREA_LIGHT_STRIDE_VEC4 * 4);
  lights.forEach((light, index) => {
    validateAreaLight(light, `areas[${index}]`);
    const { direction, up } = orthonormalBasis(light.directionView, light.upView);
    const flags = (light.twoSided ? AREA_LIGHT_FLAG_TWO_SIDED : 0) | (light.texture ? AREA_LIGHT_FLAG_TEXTURE : 0);
    const base = index * AREA_LIGHT_STRIDE_VEC4 * 4;
    packed.set([
      ...light.positionView, light.range,
      ...direction, 0,
      ...up, flags,
      light.halfExtent[0], light.halfExtent[1],
      light.texture?.uvScale[0] ?? 1, light.texture?.uvScale[1] ?? 1,
      light.texture?.uvOffset[0] ?? 0, light.texture?.uvOffset[1] ?? 0, 0, 0,
      light.color[0] * light.intensity, light.color[1] * light.intensity, light.color[2] * light.intensity, 0,
    ], base);
  });
  return { lights: packed, count: lights.length };
}
