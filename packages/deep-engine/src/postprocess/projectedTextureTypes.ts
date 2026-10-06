/// <reference types="@webgpu/types" />

/**
 * P2 六引擎对标 three r186 ProjectorLight 投影纹理(gobo/HTMLTexture)——纹理半部。
 * 语义(单源裁决,钉死口径):
 * - **投影纹理光 = 场景投射纹理**:一个投影器(位置/目标/FOV/强度/贴图)在其视锥内
 *   把 gobo 贴图作为直接光投射到受照表面(工厂投影仪/标线/视频投影语义),不是
 *   反射探针投射(后者见 reflectionProbe* 族)。
 * - **反射链路命中点的贡献**:本 pass 输出插在 SSR 之前(SSGI 同位),SSR composite
 *   在命中 UV 采色时自然携带投影贡献——反射里看到的被投影照明表面与主视图同源;
 *   projectedTextureChain 测试钉死该差分。屏空间对视锥外命中点无深度/法线,解析
 *   评估出界贡献不可为,如实登记边界。
 * - 与 IES 的分工:IES 描述聚光灯**强度角分布**(IESProfile 采样),投影纹理描述
 *   **视锥内的图像投射**;白图退化(全 1 gobo + edgeSoften=0)时本 pass 照度收敛到
 *   解析聚光公式 color×intensity×N·L×atten,该一致性由解析参考测试钉死。
 * 首切片边界(如实):无阴影图(投影不被几何遮挡,标记线场景可接受);接受域 =
 * 不透明主帧合成域(SSGI/SSR 同域,透明粒子不参与)。
 * 多投影器灯池(2026-10-06 后继切片,≤4):ProjectedTextureSource.frames 携带
 * 1..4 枚已解析投影器帧(每帧自带 gobo),参数块 544B(4×128B 子块+count+surface),
 * 核内槽序 0..3 手展开累加;单投影器 = count 1 退化路径(与旧 128B 单投影器逐位
 * 同构)。灯池超出 4 fail-closed 拒绝(打包/解析双端同判据)。
 */

export const PROJECTED_TEXTURE_COLOR_FORMAT = "rgba16float" as const satisfies GPUTextureFormat;
export const PROJECTED_TEXTURE_DEPTH_FORMAT = "r32float" as const satisfies GPUTextureFormat;
export const PROJECTED_TEXTURE_NORMAL_FORMAT = "rgba8unorm" as const satisfies GPUTextureFormat;
export const PROJECTED_TEXTURE_INPUT_COLOR_FORMAT = "rgba16float" as const satisfies GPUTextureFormat;

/** 投影器透视近截面(世界单位)。只影响 clip.w 的符号判定与深度裁剪,不影响投影 UV。 */
export const PROJECTED_TEXTURE_NEAR = 0.01;

/**
 * 作者侧投影器描述(世界空间,RenderView 每帧供给)。target 与 position 重合、
 * FOV 越界、非有限分量在解析时 fail-closed(渲染循环丢弃该帧投影器并披露,不炸帧)。
 */
export interface ProjectedTextureLight {
  readonly position: readonly [number, number, number];
  /** 视锥朝向的目标点(lookAt 合同,up=[0,1,0];与相机 lookAt 同族)。 */
  readonly target: readonly [number, number, number];
  readonly verticalFovRadians: number;
  /** 线性域光强(与解析聚光公式同一强度约定)。 */
  readonly intensity: number;
  readonly color: readonly [number, number, number];
  /** 世界单位衰减半径(>0;距离处贡献平滑归零,平方衰减)。 */
  readonly range: number;
  /** 视锥 UV 边界软化宽度(0..0.5);0 = 硬边界。 */
  readonly edgeSoften: number;
  /** gobo 贴图(filterable float/unorm 2D;采样点恒 clamp 在 [0,1],纹理寻址无关)。 */
  readonly gobo: GPUTextureView;
}

/**
 * 帧解析产物(渲染侧 resolveProjectedTextureFrame 产出 → 后处理链消费)。
 * viewToProjector 为列主序 4×4(相机相对域:世界已先经 worldToView 逆变换回视空间)。
 */
export interface ProjectedTextureFrame {
  readonly gobo: GPUTextureView;
  /** 列主序 view→projector clip(16 f32;worldToProjector × viewToWorld)。 */
  readonly viewToProjector: readonly number[];
  /** 投影器位置视空间坐标(光方向/距离在这里求)。 */
  readonly positionView: readonly [number, number, number];
  readonly intensity: number;
  readonly color: readonly [number, number, number];
  readonly range: number;
  readonly edgeSoften: number;
}

export interface ProjectedTextureSource {
  /** Composite-domain HDR color (linear), projector contribution is added onto it. */
  readonly color: GPUTexture;
  readonly depth: GPUTexture;
  readonly normal: GPUTexture;
  readonly gobo: GPUTextureView;
  /** Pre-composed view→projector clip matrix (column-major, 16 floats). */
  readonly viewToProjector: ArrayLike<number>;
  readonly positionView: readonly [number, number, number];
  readonly intensity: number;
  /** Projector light color (distinct from the HDR `color` texture above). */
  readonly lightColor: readonly [number, number, number];
  readonly range: number;
  readonly edgeSoften: number;
  readonly revision: number;
  readonly depthEncoding: "linear-view-depth-positive";
  readonly normalSpace: "view";
  readonly colorEncoding: "linear-hdr";
  /**
   * 多投影器灯池(≤4;缺省 = 单投影器退化路径):1..4 枚已解析投影器帧,槽序即
   * 累加序。frames[0] 必须与本结构扁平字段逐项一致(gobo 同一 view;矩阵/位置/
   * 强度/颜色/范围/软化相等),不一致 fail-closed 拒绝(单一事实源)。
   */
  readonly frames?: readonly ProjectedTextureFrame[];
}

export interface ProjectedTextureOptions {
  readonly verticalFovRadians: number;
  readonly passTiming?: import("../webgpu/gpuTimer.js").GpuPassTimingScope;
}

export interface ProjectedTextureResult {
  /** Borrowed until resize, device loss, or dispose. */
  readonly texture: GPUTexture;
  readonly format: typeof PROJECTED_TEXTURE_COLOR_FORMAT;
  readonly width: number;
  readonly height: number;
  readonly revision: number;
  readonly updated: boolean;
  readonly passCount: number;
}

/** CPU 镜像输入(纯数据;normals 为视空间 xyz 紧排,gobo 为 [0,1] 线性 rgb 紧排)。 */
export interface ProjectedTextureCpuInput {
  readonly width: number;
  readonly height: number;
  /** Positive linear view depth, tightly packed, row-major (0 = sky/no geometry). */
  readonly depth: readonly number[];
  /** Tightly packed view-space xyz (unorm decode is the mirror's job). */
  readonly normals: readonly number[];
  /** Linear HDR rgb, tightly packed. */
  readonly color: readonly number[];
  readonly goboWidth: number;
  readonly goboHeight: number;
  /** Linear [0,1] rgb, tightly packed. */
  readonly gobo: readonly number[];
}

/** CPU 镜像的投影器帧(纯数据;矩阵为列主序 16 f32)。 */
export interface ProjectedTextureCpuFrame {
  readonly viewToProjector: readonly number[];
  readonly positionView: readonly [number, number, number];
  readonly intensity: number;
  readonly color: readonly [number, number, number];
  readonly range: number;
  readonly edgeSoften: number;
}

export interface ProjectedTextureCpuOptions {
  readonly verticalFovRadians: number;
}

export interface ProjectedTextureCpuResult {
  readonly width: number;
  readonly height: number;
  /** Linear HDR rgb + additive projector contribution, tightly packed. */
  readonly output: Float32Array;
}
