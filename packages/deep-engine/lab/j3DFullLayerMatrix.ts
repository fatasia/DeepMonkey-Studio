// J3-D-full CPU 侧逐层双端对拍矩阵:层目录、门绑定、场景格展开与后处理 CPU 期望生成器。
// 本文件只做 CPU 可独立验证部分;实际 GPU 执行由主线程统一串行(见 scripts/j3-d-full-layer-matrix.mjs)。
// 后处理期望复用既有 lab CPU 参考(j3BloomTextureReference / j3FogProfileReference),不重写任何算法。
import { bloomTextureInput, bloomTextureBits, webBloomTextureReference,
  nativeBloomTextureReference, type BloomTextureFixture } from "./j3BloomTextureReference.js";
import { fogWebReference, type FogProfile, type FogProfileFixture } from "./j3FogProfileReference.js";
import { encodeFloat16Bits } from "./temporalAaProbe.js";

export const J3_D_FULL_SCHEMA = "j3-d-full-layer-matrix-v1";

export type J3DFullLayerId = "geometry-coverage" | "main-depth" | "normal" | "shadow-visibility"
  | "hdr-color" | "post-bloom" | "post-fog" | "display" | "texture-coverage";

export type J3DFullGateId = "geometry-depth-interior" | "normal-quantized-angle" | "shadow-half-interval"
  | "hdr-flat-strict" | "post-half-store" | "display-byte" | "texture-hdr-coverage";

/** 事前冻结的门合同。hdr002/displayByte 两个字段是".002 HDR 门与 display 字节门层内适用性"的机器可读结论。 */
export interface J3DFullGate {
  readonly id: J3DFullGateId;
  readonly formula: string;
  /** .002 严格 HDR 门适用于冻结平法线与纹理覆盖两类线性HDR附件。 */
  readonly hdr002Applicable: boolean;
  /** display 1/255 字节门是否适用于本门所辖层;全局只有 display-byte 为 true。 */
  readonly displayByteApplicable: boolean;
  /** 沿用的既有比较器(只引用,不重写)。 */
  readonly comparators: readonly string[];
}

export const J3_D_FULL_GATES: Readonly<Record<J3DFullGateId, J3DFullGate>> = Object.freeze({
  "geometry-depth-interior": Object.freeze({
    id: "geometry-depth-interior" as const,
    formula: "VP≤2e-5; 全覆盖内部像素深度均值≤2e-6; MSAA 边界差异仅允许 1px 几何轮廓",
    hdr002Applicable: false, displayByteApplicable: false,
    comparators: ["scripts/lib/j3GeometryDepthParity.mjs"] }),
  "normal-quantized-angle": Object.freeze({
    id: "normal-quantized-angle" as const,
    formula: "UNORM8 单端量化角界 0.38917633° + .01° = 双端角门 0.39917633°; world 域比较",
    hdr002Applicable: false, displayByteApplicable: false,
    comparators: ["scripts/lib/j3NormalShadowParity.mjs"] }),
  "shadow-half-interval": Object.freeze({
    id: "shadow-half-interval" as const,
    formula: "binary16 相邻数中点构造 HDR 真值区间 + 单次 f32 multiply 预算 2^-23; 双方区间必须相交",
    hdr002Applicable: false, displayByteApplicable: false,
    comparators: ["scripts/lib/j3ShadowVisibilityIntervals.mjs"] }),
  "hdr-flat-strict": Object.freeze({
    id: "hdr-flat-strict" as const,
    formula: "同 uniform 同材质同光冻结 mask: 最大通道差≤0.002、peak=1 PSNR≥60dB、SSIM≥0.9999、CPU Lambert 下界+half 量化余量 max(floor/1024,1e-6)",
    hdr002Applicable: true, displayByteApplicable: false,
    comparators: ["scripts/lib/j3HdrFlatParity.mjs"] }),
  "texture-hdr-coverage": Object.freeze({
    id: "texture-hdr-coverage" as const,
    formula: "七配置×两相机双fresh；UV/sRGB/MR/alpha独立参考、稳定域HDR最大通道差≤0.002；MASK/单层BLEND边界差仅1px",
    hdr002Applicable: true, displayByteApplicable: false,
    comparators: ["scripts/lib/j3TextureCoverageParity.mjs"] }),
  "post-half-store": Object.freeze({
    id: "post-half-store" as const,
    formula: "各宿主对独立 CPU 参考: abs(actual-expected) ≤ 0.003 + |expected|*0.004(含半精度 store 幅度项); 跨宿主等值不是门,只记录诊断差异",
    hdr002Applicable: false, displayByteApplicable: false,
    comparators: ["scripts/lib/j3BloomTextureParity.mjs", "scripts/lib/j3FogProfileParity.mjs"] }),
  "display-byte": Object.freeze({
    id: "display-byte" as const,
    formula: "显示域 8bit 字节: 最大通道差≤1/255、每块 SSIM≥0.999; WGSL/GLSL 浮点库≤2e-5",
    hdr002Applicable: false, displayByteApplicable: true,
    comparators: ["scripts/lib/j3DisplayParity.mjs"] }),
});

export interface J3DFullLayer {
  readonly id: J3DFullLayerId;
  readonly title: string;
  readonly attachments: { readonly web: string; readonly native: string };
  readonly evidenceDir: string;
  /** evidence.scope 必须以任一前缀开头,防止错层证据互换;法线层同时接受统一 fresh 回执(含 normals)。 */
  readonly scopePrefixes: readonly string[];
  readonly gateId: J3DFullGateId;
  readonly sceneCellSource: "geometry-manifest-cameras" | "bloom-fixture-cases"
    | "fog-fixture-profiles" | "display-fixture-colors" | "texture-fixture-scenarios";
  readonly fixtureFile?: string;
  readonly freshnessKey?: "packageHash" | "fixtureHash" | "profileHash";
  readonly status: "verified-2026-09-30" | "verified-2026-10-01" | "cpu-prep-only";
}

export const J3_D_FULL_LAYERS: readonly J3DFullLayer[] = Object.freeze([
  Object.freeze({ id: "texture-coverage" as const, title: "纹理UV/MR/alpha覆盖",
    attachments: { web: "生产PbrRenderer rgba16float", native: "生产shader_material_renderer Rgba16Float" },
    evidenceDir: "test-output/interrupted-0930/texture-coverage", scopePrefixes: ["actual-production-texture-UV-MR-alpha-coverage"],
    gateId: "texture-hdr-coverage" as const, sceneCellSource: "texture-fixture-scenarios" as const,
    fixtureFile: "packages/deep-engine/fixtures/j3-texture-coverage-v1.json", freshnessKey: "profileHash" as const,
    status: "verified-2026-10-01" as const }),
  Object.freeze({ id: "geometry-coverage" as const, title: "几何覆盖 mask",
    attachments: { web: "PbrRenderer depthTexture depth32float 1x 覆盖", native: "ForwardTargets depth Depth24Plus 4xMSAA 逐样本覆盖" },
    evidenceDir: "test-output/interrupted-0930/geometry-depth", scopePrefixes: ["production-geometry-depth-interior"],
    gateId: "geometry-depth-interior" as const, sceneCellSource: "geometry-manifest-cameras" as const,
    fixtureFile: "packages/deep-engine/fixtures/j3-geometry-depth-v1.json", freshnessKey: "packageHash" as const,
    status: "verified-2026-09-30" as const }),
  Object.freeze({ id: "main-depth" as const, title: "主视角深度",
    attachments: { web: "depthTexture depth32float 1x 中心样本", native: "encode_opaque_pass(retain_depth) 4 样本均值观察" },
    evidenceDir: "test-output/interrupted-0930/geometry-depth", scopePrefixes: ["production-geometry-depth-interior"],
    gateId: "geometry-depth-interior" as const, sceneCellSource: "geometry-manifest-cameras" as const,
    fixtureFile: "packages/deep-engine/fixtures/j3-geometry-depth-v1.json", freshnessKey: "packageHash" as const,
    status: "verified-2026-09-30" as const }),
  Object.freeze({ id: "normal" as const, title: "法线附件(mapped world normal)",
    attachments: { web: "RenderTargets viewNormal rgba8unorm + 正式 worldToView 转换", native: "NormalCaptureTargets opt-in worldNormal+roughness" },
    // canonical fresh 回执 = shadow-visibility/evidence.json(统一 runner 同批写 normals);normal-shadow/ 是历史首刀 receipt。
    evidenceDir: "test-output/interrupted-0930/shadow-visibility", scopePrefixes: ["actual Web normal attachment", "actual production HDR shadow visibility"],
    gateId: "normal-quantized-angle" as const, sceneCellSource: "geometry-manifest-cameras" as const,
    fixtureFile: "packages/deep-engine/fixtures/j3-hdr-flat-normal-v1.json",
    status: "verified-2026-09-30" as const }),
  Object.freeze({ id: "shadow-visibility" as const, title: "共同 4 级联阴影可见度",
    attachments: { web: "生产 HDR/control 比值 + CSM uniform 39vec4/624B", native: "生产 HDR/control 比值 + sampling_uniform 21vec4/336B" },
    evidenceDir: "test-output/interrupted-0930/shadow-visibility", scopePrefixes: ["actual production HDR shadow visibility"],
    gateId: "shadow-half-interval" as const, sceneCellSource: "geometry-manifest-cameras" as const,
    fixtureFile: "packages/deep-engine/fixtures/j3-hdr-flat-normal-v1.json",
    status: "verified-2026-09-30" as const }),
  Object.freeze({ id: "hdr-color" as const, title: "线性 HDR 颜色(严格平法线子集)",
    attachments: { web: "PBR_HDR_FORMAT rgba16float", native: "FORWARD_COLOR_FORMAT Rgba16Float resolved" },
    // 证据目录对齐现行门:j3-normal-shadow-parity.mjs(读同一 hdr-flat-normal fixture 的双半对拍)输出至 normal-shadow。
    evidenceDir: "test-output/interrupted-0930/normal-shadow", scopePrefixes: ["production-HDR-authored-single-sun-flat-normal-triangles"],
    gateId: "hdr-flat-strict" as const, sceneCellSource: "geometry-manifest-cameras" as const,
    fixtureFile: "packages/deep-engine/fixtures/j3-hdr-flat-normal-v1.json", freshnessKey: "packageHash" as const,
    status: "verified-2026-09-30" as const }),
  Object.freeze({ id: "post-bloom" as const, title: "Bloom 后处理输出(各宿主合法 profile)",
    attachments: { web: "BloomPass 5 级线性 HDR 合成 rgba16float", native: "BloomPass 半分辨率 blurred + OutputPass 显示域" },
    evidenceDir: "test-output/interrupted-0930/bloom-texture", scopePrefixes: ["actual-production-Bloom-textures-per-legal-profile"],
    gateId: "post-half-store" as const, sceneCellSource: "bloom-fixture-cases" as const,
    fixtureFile: "packages/deep-engine/fixtures/j3-bloom-texture-v1.json", freshnessKey: "fixtureHash" as const,
    status: "verified-2026-09-30" as const }),
  Object.freeze({ id: "post-fog" as const, title: "Fog 后处理输出(合法模式/高度/HG)",
    attachments: { web: "VolumetricFogPass scatter + Composite 线性 HDR", native: "OutputPass 显示域 exp/volume" },
    evidenceDir: "test-output/interrupted-0930/fog-profiles", scopePrefixes: ["actual-legal-Fog-profiles"],
    gateId: "post-half-store" as const, sceneCellSource: "fog-fixture-profiles" as const,
    fixtureFile: "packages/deep-engine/fixtures/j3-fog-profiles-v1.json", freshnessKey: "fixtureHash" as const,
    status: "verified-2026-09-30" as const }),
  Object.freeze({ id: "display" as const, title: "Display 输出(曝光/ACES/sRGB 共同档)",
    attachments: { web: "pbrOutputShader RGBA8 UNORM", native: "OutputPass RGBA8 UNORM" },
    evidenceDir: "test-output/interrupted-0930/display-parity", scopePrefixes: ["production-output-common-subset"],
    gateId: "display-byte" as const, sceneCellSource: "display-fixture-colors" as const,
    fixtureFile: "packages/deep-engine/fixtures/display-parity-v1.json",
    status: "verified-2026-09-30" as const }),
]);

/** 层 id → 唯一门绑定;聚合器据此拦截"错门"目录。 */
export const REQUIRED_LAYER_GATE: Readonly<Record<J3DFullLayerId, J3DFullGateId>> = Object.freeze(
  Object.fromEntries(J3_D_FULL_LAYERS.map(layer => [layer.id, layer.gateId])) as Record<J3DFullLayerId, J3DFullGateId>);

/** 数字不变量:display 字节 LSB(1/255)严于 .002 HDR 门,因此两个门互不可互换(互换必属放水/过严)。 */
export const DISPLAY_BYTE_LSB = 1 / 255;
export const HDR_STRICT_CHANNEL_ERROR = 0.002;

export interface LayerSceneCell { readonly cellId: string; readonly hostScope: "web+native" | "web-only" | "native-only" }

/** 层×场景格展开:场景格身份全部来自冻结 fixture/manifest,不在 GPU 后选格。 */
export function expandSceneCells(layer: J3DFullLayer, fixtureData: unknown): readonly LayerSceneCell[] {
  const data = fixtureData as Record<string, unknown>;
  switch (layer.sceneCellSource) {
    case "geometry-manifest-cameras":
      return ((data.cameras as readonly { id: string }[]) ?? []).map(camera =>
        Object.freeze({ cellId: camera.id, hostScope: "web+native" as const }));
    case "bloom-fixture-cases":
      return ((data.cases as readonly string[]) ?? []).map(id =>
        Object.freeze({ cellId: id, hostScope: "web+native" as const }));
    case "fog-fixture-profiles": {
      const shared = ((data.profiles as readonly FogProfile[]) ?? []).map(profile =>
        Object.freeze({ cellId: profile.id, hostScope: "web+native" as const }));
      const nativeOnly = ((data.nativeOnly as readonly FogProfile[]) ?? []).map(profile =>
        Object.freeze({ cellId: profile.id, hostScope: "native-only" as const }));
      return [...shared, ...nativeOnly];
    }
    case "display-fixture-colors":
      return ((data.colors as readonly unknown[]) ?? []).map((_, index) =>
        Object.freeze({ cellId: `swatch-${index}`, hostScope: "web+native" as const }));
    case "texture-fixture-scenarios":
      return ((data.scenarios as readonly string[]) ?? []).flatMap(scenario =>
        ((data.cameras as readonly { id: string }[]) ?? []).map(camera =>
          Object.freeze({ cellId: `${camera.id}/${scenario}`, hostScope: "web+native" as const })));
  }
}

// ---------- 后处理逐层 CPU 期望生成器(复用既有参考,不重写) ----------

/** FNV-1a 64:对 half bits 稳定、跨运行可复现的期望摘要;供 GPU 前登记与事后复核。 */
export function halfBitsDigest(pixels: ArrayLike<number>): string {
  const bits = Uint16Array.from(pixels as ArrayLike<number>, encodeFloat16Bits);
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < bits.length; index++) {
    hash ^= BigInt(bits[index]!);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

export interface PostExpectationCell {
  readonly cellId: string;
  readonly host: "web" | "native";
  readonly profile: string;
  readonly pixels: number;
  readonly referenceDigest?: string;
  /** Native fog 期望依赖实际观察 frame(由 GPU runner 以 fogNativeReference 物化),CPU 侧只登记绑定。 */
  readonly nativeFrameDependent?: boolean;
}

export interface PostLayerExpectation {
  readonly layerId: "post-bloom" | "post-fog" | "display";
  readonly gateId: J3DFullGateId;
  readonly reusedReference: readonly string[];
  readonly tolerances: { readonly absolute: number; readonly relative?: number };
  readonly crossHostEqualityGate: false;
  readonly cells: readonly PostExpectationCell[];
}

/** Bloom 层:web/native 两侧期望全部在 CPU 生成(沿 j3-bloom-texture 既有参考与参数)。 */
export function buildBloomExpectations(fixture: BloomTextureFixture): PostLayerExpectation {
  const cells = fixture.cases.flatMap(id => {
    const source = bloomTextureInput(id, fixture.width, fixture.height);
    const web = webBloomTextureReference(source, fixture.web);
    const native = nativeBloomTextureReference(source, fixture.native);
    return [
      { cellId: id, host: "web" as const, profile: `threshold${fixture.web.threshold}/intensity${fixture.web.intensity}/${fixture.web.maxLevels}levels`,
        pixels: web.pixels.length / 4, referenceDigest: halfBitsDigest(web.pixels) },
      { cellId: id, host: "native" as const, profile: `blur half-res r${fixture.native.radius}/intensity${fixture.native.intensity}+display`,
        pixels: native.display.pixels.length / 4, referenceDigest: halfBitsDigest(native.display.pixels) },
    ];
  });
  return { layerId: "post-bloom", gateId: "post-half-store", reusedReference: ["packages/deep-engine/lab/j3BloomTextureReference.ts"],
    tolerances: { absolute: fixture.absoluteTolerance, relative: fixture.relativeTolerance },
    crossHostEqualityGate: false, cells };
}

/** Fog 层:web 期望 CPU 生成;native 期望 frame 依赖,仅登记绑定(由 GPU runner 物化)。 */
export function buildFogExpectations(fixture: FogProfileFixture): PostLayerExpectation {
  const webCells = fixture.profiles.map(profile => {
    const composite = fogWebReference(fixture, profile).composite;
    return { cellId: profile.id, host: "web" as const, profile: `density${profile.density}/H${profile.height}/g${profile.g}/steps${profile.steps}${profile.sky ? "/sky" : ""}`,
      pixels: composite.length / 4, referenceDigest: halfBitsDigest(composite) };
  });
  const nativeCells = [...fixture.profiles, ...fixture.nativeOnly].flatMap(profile =>
    fixture.nativeEyeY.map(eyeY => ({ cellId: profile.id, host: "native" as const,
      profile: `eyeY${eyeY}${profile.exponential ? "/exponential" : ""}${profile.sky ? "/sky" : ""}`,
      pixels: fixture.width * fixture.height, nativeFrameDependent: true })));
  return { layerId: "post-fog", gateId: "post-half-store", reusedReference: ["packages/deep-engine/lab/j3FogProfileReference.ts"],
    tolerances: { absolute: fixture.absoluteTolerance, relative: fixture.relativeTolerance },
    crossHostEqualityGate: false, cells: [...webCells, ...nativeCells] };
}

/** Display 层:期望即门绑定 + 冻结色块身份;实际期望像素由生产 outputShader/OutputPass 在 GPU 生成。 */
export function buildDisplayExpectations(fixture: Record<string, unknown>): PostLayerExpectation {
  const thresholds = fixture.thresholds as { outputMaxByteError: number; outputMinSsim: number; libraryMaxFloatError: number };
  const colors = fixture.colors as readonly unknown[];
  return { layerId: "display", gateId: "display-byte", reusedReference: ["scripts/lib/j3DisplayParity.mjs", "packages/deep-engine/fixtures/display-parity-v1.json"],
    tolerances: { absolute: thresholds.outputMaxByteError / 255 },
    crossHostEqualityGate: false,
    cells: colors.map((_, index) => ({ cellId: `swatch-${index}`, host: "web" as const, profile: "exposure1/Narkowicz-ACES/sRGB",
      pixels: (fixture.width as number) * (fixture.height as number) })) };
}
