/// <reference types="@webgpu/types" />
import type { DeviceSession } from "../webgpu/deviceSession.js";
import { createAdmittedBuffer, createAdmittedTexture } from "../webgpu/resourceAdmission.js";
import { uploadBuffer } from "../webgpu/meshBuffers.js";
import type { ProbeClipmapLightingBinding } from "../lighting/pbrLightingBindings.js";
import { packProbeLevels } from "../lighting/probeClipmapResourceData.js";
import type { ProbeClipmapLevel } from "../lighting/probeClipmapPlan.js";
import { DEEP_SDF_GI_PUBLISH_WGSL, SDF_GI_PUBLISH_ENTRY, SDF_GI_PUBLISH_PARAMS_BYTES,
  SDF_GI_PUBLISH_RECORD_VEC4_STRIDE, SDF_GI_PUBLISH_WORKGROUP_SIZE } from "./sdfGiPublishWgsl.js";
import { SDF_GI_PROBE_RECORD_VEC4_STRIDE } from "./sdfGiProbeUpdateWgsl.js";

/**
 * Brief-GI M3 探针消费发布运行时:把 96B IrradianceProbeRecord 探针场物化为主 pass
 * 探针 clipmap 采样纹理(group3 纹理 ABI),经 ForwardPlusPbrLightingsBindings.
 * setProbeClipmap 发布 —— pbrShader shade() 的 ambient 项
 * `mix(environmentIrradiance, gi.rgb, gi.a)` 从此真实消费 SDF GI 探针记录。
 *
 * == texel 布局合同(与 wgsl/sdfGiPublish.wgsl 互钉;文件头有完整推导)==
 * - volume:rgba16float 2d-array,[dx,dy,dz];texel = record vec4[0](irradiance,validity);
 * - moments:rgba32float 2d-array,[dx,dy,dz×4 lane];lane0 = vec4[1].xyz+(valid=1),
 *   lane1..3 恒零(F5 words[12..23] SH 缺失合同,specular 门走标量 fallback);
 * - metadata:packProbeLevels 单层(采样端 DeepGiTextureLevel struct 同源打包)。
 * 采样端 realMoments 判据(moments 2D 尺寸==gridSize.xy 且 layers>=dz×4)恰好满足。
 *
 * == 开关语义 ==
 * features.sdfGi 关 = 本运行时不存在,setProbeClipmap 从不被 SDF GI 调用 → 主 pass
 * group3 保持 F1 fallback,既有帧逐位零变化;开启后本运行时在每帧 update 窗口之后
 * dispatch 物化(≤4096 texel,同 encoder 顺序保证写后读),像素随之反映探针场内容。
 */

// WebGPU usage 数值常量(node/vitest stub 环境无 GPUBufferUsage/GPUTextureUsage 全局,
// 模块顶层禁止求值 GPU 全局)。注意两表位值不同:buffer COPY_SRC=0x4/纹理 COPY_SRC=0x1。
const USAGE_COPY_DST = 0x8, USAGE_UNIFORM = 0x40; // buffer 表
const TEXTURE_COPY_SRC = 0x1, TEXTURE_BINDING = 0x4, STORAGE_BINDING = 0x8; // 纹理表
const PUBLISHED_TEXTURE_USAGE = TEXTURE_BINDING | STORAGE_BINDING | TEXTURE_COPY_SRC;

/**
 * 探针格 → 采样合同 level(主 pass DeepGiTextureLevel 的 CPU 单源;探针格内缩半格
 * 由 sdfGiProductionRuntime 的 lattice 边界承担,此处原样透传格几何)。
 *
 * == max 外扩一个 spacing(GI-FIN 归因修复,2026-10-05)==
 * lattice 的 floor 取整会让末端探针平面到烘焙域边界欠冲最多一个 spacing(实测参考
 * 房间:x 末端欠冲 0.45m,+x 墙面整体落在 max 之外 → contains 拒绝 → gi.a=0 → 开关
 * 逐位相同,变化区塌缩成探针域内子域)。max 外扩一个 spacing 后 contains 覆盖全部
 * 烘焙域;外插段由采样端坐标钳制(`low=min(floor,gridSize−2)` + `fraction` 钳 1)
 * 天然收敛到末端探针列,插值权重/探针位置仍按 origin+cell×spacing 计算,合同零漂移;
 * CPU 镜像(sampleIrradianceProbeClipmap)消费同一 level 对象,同口径自动保持。
 */
export function sdfGiPublishLevel(origin: readonly [number, number, number], spacing: number,
  dimensions: readonly [number, number, number]): ProbeClipmapLevel {
  if (!(spacing > 0) || !Number.isFinite(spacing)) throw new RangeError("SDF GI publish spacing must be positive finite.");
  if (dimensions.some(value => !Number.isSafeInteger(value) || value < 2)) {
    throw new RangeError("SDF GI publish dimensions must be integers >= 2 per axis.");
  }
  const max: [number, number, number] = [
    origin[0]! + dimensions[0]! * spacing,
    origin[1]! + dimensions[1]! * spacing,
    origin[2]! + dimensions[2]! * spacing,
  ];
  return { level: 0, gridSize: [...dimensions], spacing, originCell: [0, 0, 0],
    origin: [...origin], max, probeCount: dimensions[0]! * dimensions[1]! * dimensions[2]! };
}

/** PublishParams 打包(32B;WGSL struct 布局:vec3u@0(对齐16)+3×u32 → 尺寸 32,
 * Chrome 按 struct 全长取 minBindingSize(真机实测;与 clothParallel 48B 同教训)。 */
export function packSdfGiPublishParams(dimensions: readonly [number, number, number],
  probeCount: number): Uint32Array<ArrayBuffer> {
  const words = new Uint32Array(SDF_GI_PUBLISH_PARAMS_BYTES / 4);
  words[0] = dimensions[0]!;
  words[1] = dimensions[1]!;
  words[2] = dimensions[2]!; // probeCount 落 @12(vec3u 尺寸 12,对齐 4)
  words[3] = probeCount;
  words[4] = SDF_GI_PUBLISH_RECORD_VEC4_STRIDE; // @16
  words[5] = 4;                                  // @20 momentLanes(F5 合同)
  return words;
}

/**
 * f32 → f16 位型(IEEE754 round-to-nearest-even;离线对拍参考,非热路径)。
 * 舍入上溢 → +inf(0x7c00):与 rgba16float storage 写入的表示范围语义一致;
 * subnormal 区用数值量化(m = round(value·2^24),该区 f32 值远大于步长,对拍容差内)。
 */
export function halfFloatBits(value: number): number {
  const bits = new Uint32Array(new Float32Array([value]).buffer)[0]!;
  const sign = (bits >>> 16) & 0x8000;
  const biased = bits & 0x7fffffff;
  if (biased >= 0x7f800000) return sign | 0x7c00 | (biased > 0x7f800000 ? 0x200 : 0);
  if (biased >= 0x38800000) { // f16 normal(≥ 2^-14):重偏置 0x38000000 后尾数舍入
    let half = biased - 0x38000000;
    const remainder = half & 0x1fff;
    half = (half >>> 13) + (remainder > 0x1000 ? 1 : remainder === 0x1000 ? (half >>> 13) & 1 : 0);
    return sign | (half >= 0x7c00 ? 0x7c00 : half);
  }
  if (biased < 0x32000000) return sign; // < 2^-25:舍入到 ±0
  return sign | Math.round(value * 2 ** 24); // f16 subnormal
}

/** rgba16float 量化(f32 值经 f16 往返;volume texel 对拍的期望值生成器)。 */
export function quantizeHalf(value: number): number {
  const word = halfFloatBits(value);
  const exponent = (word & 0x7c00) >>> 10;
  if (exponent === 0) { // subnormal:f16 subnormal = 尾数 × 2^-24
    return (word & 0x8000 ? -1 : 1) * (word & 0x3ff) * 2 ** -24;
  }
  if (exponent === 31) return word & 0x3ff ? NaN : (word & 0x8000 ? -Infinity : Infinity);
  return (word & 0x8000 ? -1 : 1) * (1 + (word & 0x3ff) / 1024) * 2 ** (exponent - 15);
}

/** 物化核每 lane 的期望 volume texel(与 wgsl 透传合同同源;单测与真机对拍共用)。 */
export function expectedSdfGiVolumeTexel(record: Readonly<{ irradiance: readonly [number, number, number];
  validity: number }>): readonly [number, number, number, number] {
  return [quantizeHalf(record.irradiance[0]!), quantizeHalf(record.irradiance[1]!),
    quantizeHalf(record.irradiance[2]!), quantizeHalf(record.validity)];
}

/** 物化核每 cell 的期望 moments lane0(rgba32float 无量化;lane1..3 恒零见 WGSL 合同)。 */
export function expectedSdfGiMomentLanes(record: Readonly<{ meanDistance: number;
  distanceVariance: number; occlusionFloor?: number }>): readonly [number, number, number, number] {
  return [record.meanDistance, record.distanceVariance, record.occlusionFloor ?? 0, 1];
}

interface PublishedResources {
  readonly volume: GPUTexture; readonly volumeView: GPUTextureView;
  readonly moments: GPUTexture; readonly momentsView: GPUTextureView;
  readonly metadata: GPUBuffer; readonly params: GPUBuffer;
  readonly bindGroup: GPUBindGroup;
  /** 绑定中的记录 buffer(复用检查:槽位重建后 records 必然换新,必须重建发布资源)。 */
  readonly records: GPUBuffer;
  readonly level: ProbeClipmapLevel;
  readonly dispatchCount: number;
}

/** 探针消费发布运行时(features.sdfGi 开启时由 SdfGiProductionRuntime 持有)。 */
export class SdfGiPublishRuntime {
  private readonly pipeline: GPUComputePipeline;
  private readonly layout: GPUBindGroupLayout;
  private sampler: GPUSampler | undefined;
  private resources: PublishedResources | undefined;
  private disposed = false;

  constructor(private readonly session: DeviceSession) {
    const device = session.device;
    this.layout = device.createBindGroupLayout({ label: "Deep SDF GI publish layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform",
          minBindingSize: SDF_GI_PUBLISH_PARAMS_BYTES } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: "write-only", format: "rgba16float", viewDimension: "2d-array" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: "write-only", format: "rgba32float", viewDimension: "2d-array" } },
      ] });
    this.pipeline = device.createComputePipeline({ label: "Deep SDF GI publish pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: { module: device.createShaderModule({ label: "Deep SDF GI publish WGSL",
        code: DEEP_SDF_GI_PUBLISH_WGSL }), entryPoint: SDF_GI_PUBLISH_ENTRY } });
  }

  /**
   * 重建/复用物化资源(烘焙帧调用;格几何或记录 buffer 变化才重建,内容每帧由核覆写)。
   * 复用检查含 records 同一性:二次烘焙时槽位 records 换新(旧 buffer 已释放),
   * 沿用旧 bindGroup 会让核写已销毁 buffer(真机实测 uncaptured error)。
   * 布局合同:volume=[dx,dy,dz] 层 rgba16float;moments=[dx,dy,dz×4] 层 rgba32float。
   */
  prepare(level: ProbeClipmapLevel, records: GPUBuffer): void {
    if (this.disposed) throw new Error("SDF GI publish runtime is disposed.");
    const [dx, dy, dz] = level.gridSize;
    if (this.resources && this.resources.records === records
      && this.resources.level.probeCount === level.probeCount
      && this.resources.volume.width === dx && this.resources.volume.height === dy
      && this.resources.volume.depthOrArrayLayers === dz) return;
    const device = this.session.device;
    const created: (GPUTexture | GPUBuffer)[] = [];
    try {
      const volume = createAdmittedTexture(this.session, { label: "Deep SDF GI published volume",
        size: [dx, dy, dz], format: "rgba16float", usage: PUBLISHED_TEXTURE_USAGE });
      const moments = createAdmittedTexture(this.session, { label: "Deep SDF GI published moments",
        size: [dx, dy, dz * 4], format: "rgba32float", usage: PUBLISHED_TEXTURE_USAGE });
      created.push(volume, moments);
      const metadata = createAdmittedBuffer(this.session, { label: "Deep SDF GI publish level metadata",
        size: 256, usage: USAGE_UNIFORM | USAGE_COPY_DST });
      const params = uploadBuffer(this.session, "Deep SDF GI publish params",
        packSdfGiPublishParams(level.gridSize, level.probeCount), USAGE_UNIFORM);
      created.push(metadata, params);
      device.queue.writeBuffer(metadata, 0, new Uint32Array(packProbeLevels([level])));
      const volumeView = volume.createView({ dimension: "2d-array" });
      const momentsView = moments.createView({ dimension: "2d-array" });
      const bindGroup = device.createBindGroup({ label: "Deep SDF GI publish bindings",
        layout: this.layout, entries: [
          { binding: 0, resource: { buffer: params } },
          { binding: 1, resource: { buffer: records } },
          { binding: 2, resource: volumeView },
          { binding: 3, resource: momentsView },
        ] });
      this.releaseResources();
      this.resources = { volume, volumeView, moments, momentsView, metadata, params, bindGroup,
        records, level, dispatchCount: Math.ceil(level.probeCount / SDF_GI_PUBLISH_WORKGROUP_SIZE) };
    } catch (error) {
      for (const resource of created.reverse()) this.session.release(resource);
      throw error;
    }
  }

  /** 物化 dispatch(挂调用方 encoder;必须在探针 update 窗口 pass 之后,写后读顺序)。 */
  encode(encoder: GPUCommandEncoder): void {
    if (this.disposed) throw new Error("SDF GI publish runtime is disposed.");
    const resources = this.resources;
    if (!resources) return;
    const pass = encoder.beginComputePass({ label: "Deep SDF GI publish" });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, resources.bindGroup);
    pass.dispatchWorkgroups(resources.dispatchCount);
    pass.end();
  }

  /** 主 pass 发布面(group3 GI 槽;undefined = 场景未就绪,宿主回落 F1 fallback)。 */
  get published(): ProbeClipmapLightingBinding | undefined {
    const resources = this.resources;
    if (!resources) return undefined;
    return { view: resources.volumeView, sampler: this.sampler ??= this.session.device.createSampler({
        label: "Deep SDF GI publish sampler", magFilter: "linear", minFilter: "linear",
        addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", addressModeW: "clamp-to-edge" }),
      levelMetadataBuffer: resources.metadata, momentsView: resources.momentsView };
  }

  /** 发布格几何与纹理引用(真机探针/验收读回面;undefined = 场景未就绪)。 */
  get publishedTextures(): { readonly volume: GPUTexture; readonly moments: GPUTexture;
    readonly level: ProbeClipmapLevel } | undefined {
    const resources = this.resources;
    if (!resources) return undefined;
    return { volume: resources.volume, moments: resources.moments, level: resources.level };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseResources();
    // sampler 不进 session 资源账本(pbrLightingBindings fallback sampler 同先例:
    // 该 @webgpu/types 版本 GPUSampler 无 destroy,设备销毁兜底)。
    this.sampler = undefined;
  }

  private releaseResources(): void {
    const resources = this.resources;
    if (!resources) return;
    for (const resource of [resources.volume, resources.moments, resources.metadata,
      resources.params] as const) {
      this.session.release(resource);
    }
    this.resources = undefined;
  }
}

/** 物化核 ABI 自检(与 sdfGiProbeUpdateWgsl 的记录步长互钉;漂移在模块加载期爆)。 */
if (SDF_GI_PUBLISH_RECORD_VEC4_STRIDE !== SDF_GI_PROBE_RECORD_VEC4_STRIDE) {
  throw new Error("SDF GI publish record ABI drifted from the probe update contract.");
}
