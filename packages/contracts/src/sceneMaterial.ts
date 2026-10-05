export interface SceneMaterialState {
  /** Bound DeepSL source; compiled into a shader package when publishing this material. */
  customShader?: { source: string } | undefined;
  /** Preserve source linear color precision when restoring authored glTF materials. */
  sourceColor?: boolean;
  sourceEmissive?: boolean;
  /** Instance-local glTF source material index overrides; never runtime UUIDs. */
  slotOverrides?: Record<string, Omit<SceneMaterialState, "slotOverrides">>;
  color?: string;
  /** 实例级颜色校正；不改写原始素材，可为同一素材的不同实例保存不同外观。 */
  hue?: number;
  saturation?: number;
  brightness?: number;
  contrast?: number;
  baseColorMapUrl?: string;
  baseColorMapName?: string;
  normalMapUrl?: string;
  normalMapName?: string;
  emissiveMapUrl?: string;
  emissiveMapName?: string;
  ambientOcclusionMapUrl?: string;
  ambientOcclusionMapName?: string;
  roughnessMapUrl?: string;
  roughnessMapName?: string;
  metalnessMapUrl?: string;
  metalnessMapName?: string;
  /** @deprecated 旧场景的等比 UV 重复；新编辑器使用独立 U/V 参数。 */
  textureRepeat?: number;
  /** 贴图沿 U/V 方向的独立重复次数，适配长条设备和非方形表面。 */
  textureRepeatX?: number;
  textureRepeatY?: number;
  /** 贴图静态偏移；与 UV 动画叠加，用于校正铭牌和输送带等 PBR 纹理位置。 */
  textureOffsetX?: number;
  textureOffsetY?: number;
  textureRotation?: number;
  /** 贴图 UV 动画；用于输送带、流水、灯带等连续运动材质。 */
  uvAnimation?: SceneMaterialUvAnimationState;
  /** 将图片或视频映射到选中模型/构件表面，用于工业看板、电视和设备屏幕。 */
  screen?: SceneMaterialScreenState;
  normalScale?: number;
  roughness?: number;
  /** Dielectric index of refraction; source values are preserved, default 1.5. */
  ior?: number;
  /**
   * MeshPhysicalMaterial 扩展 lobes(three r185 语义,线性值,缺省 = 中性)。仅在 Deep 渲染器
   * 启用 advancedMaterials 变体时求值;贴图类扩展不在本合同内。JSON 无法表达 Infinity,
   * attenuationDistance 缺省即不衰减。
   */
  clearcoat?: number;
  clearcoatRoughness?: number;
  sheen?: number;
  sheenRoughness?: number;
  /** #RRGGBB;与 sheen 标量相乘得到有效光泽色。 */
  sheenColor?: string;
  iridescence?: number;
  iridescenceIOR?: number;
  /** iridescenceThicknessRange 的上界(nm);three 无贴图时只取上界。 */
  iridescenceThicknessMax?: number;
  transmission?: number;
  thickness?: number;
  attenuationColor?: string;
  /** 缺省/显式 undefined = 不衰减(three 的无限距离)。 */
  attenuationDistance?: number | undefined;
  metalness?: number;
  emissive?: string;
  emissiveIntensity?: number;
  wireframe?: boolean;
  doubleSided?: boolean;
  /** 基于 MeshStandardMaterial.onBeforeCompile 的轻量着色器效果；不改写 PBR 管线，保持场景光照一致。 */
  shaderEffect?: SceneMaterialShaderEffect | undefined;
}

export interface SceneMaterialShaderEffect {
  kind: "fresnel-rim";
  /** 轮廓光颜色；#RRGGBB。 */
  color: string;
  /** 边缘光强度 0-4；0 等效关闭。 */
  intensity: number;
}

export interface SceneMaterialScreenState {
  enabled: boolean;
  sourceType: "image" | "video";
  url: string;
  name?: string;
  /** 视频进入预览后是否立即播放；图片类型忽略此字段。 */
  autoplay: boolean;
  loopMode: "once" | "loop";
  muted: boolean;
  /** 屏幕作为自发光表面的亮度，避免依赖场景照明才能看清。 */
  emissiveIntensity: number;
}

/**
 * 用户自定义材质预设(编辑器刀 5):作者把调好的对象材质参数存为可复用预设,
 * 与内置工业预设同面板套用。只序列化标量外观域(不含贴图/屏幕/UV 动画/
 * shaderEffect/slotOverrides),跨场景复用不携带项目资源依赖。
 */
export interface UserMaterialPresetDefinition {
  /** 形如 `matpreset:<uuid>`;场景内唯一。 */
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  values: SceneMaterialState;
}

/**
 * 可编辑材质图定义(编辑器刀 7,Tier-2):分层材质(底材质 + ≤4 调整层 × 遮罩)的
 * 持久化形状,与 apps/web 的 MaterialGraphDefinition 结构对齐(契约只定形状,
 * 收敛与编译逻辑留在应用侧)。以场景对象 id 为键存于 SceneSnapshot.materialGraphs;
 * 只持久化定义本身,编译产物(参数+预合成贴图)仍走既有材质序列化。
 */

/** 底材质节点 = PBR 参数快照(编译合成基底,不直接写回对象)。 */
export interface SceneMaterialGraphBaseState {
  /** #RRGGBB。 */
  color: string;
  metalness: number;
  roughness: number;
}

/** 遮罩参数:程序化 3 种共用采样参数;texture 另带上传灰度图(dataURL ≤256KB)。 */
export interface SceneMaterialGraphMaskState {
  kind: "wear" | "dust" | "stripes" | "texture";
  /** 确定性种子(整数);同图同输出字节的根。 */
  seed: number;
  /** 图案密度 1–8(周期格数,平铺无缝)。 */
  scale: number;
  /** 覆盖率 0–1。 */
  coverage: number;
  /** 边缘柔和 0–1。 */
  softness: number;
  /** 图案角度(度,条纹/划痕方向)。 */
  angle: number;
  textureName?: string;
  textureUrl?: string;
}

/** 调整层:每通道独立开关,遮罩只作用于启用通道。 */
export interface SceneMaterialGraphLayerState {
  id: string;
  name: string;
  enabled: boolean;
  blend: "mix" | "multiply";
  color: string;
  useColor: boolean;
  roughness: number;
  useRoughness: boolean;
  metalness: number;
  useMetalness: boolean;
  /** 凹凸高度贡献 0–1(编译为法线贴图)。 */
  bump: number;
  /** 层强度 0–1。 */
  opacity: number;
  mask: SceneMaterialGraphMaskState;
}

export interface SceneMaterialGraphDefinition {
  /** 合同版本;序列化演进从 2 开始。 */
  version: 1;
  /** 形如 `matgraph:<uuid>`;场景内唯一。 */
  id: string;
  name: string;
  base: SceneMaterialGraphBaseState;
  layers: SceneMaterialGraphLayerState[];
  updatedAt: string;
}

export interface SceneMaterialUvAnimationState {
  enabled: boolean;
  /** 关闭循环时从进入场景开始播放一次。 */
  loopMode?: "once" | "loop";
  /** 播放一次的时长；循环模式下用于定义一个逻辑周期。 */
  durationSeconds?: number;
  /** 每秒沿 U/V 方向移动的 UV 单位。 */
  offsetSpeedX: number;
  offsetSpeedY: number;
  /** 每秒旋转弧度，正值为逆时针。 */
  rotationSpeed: number;
}
