/**
 * B2 frame v8 双端逐字节 golden 对拍 fixture 生成器(TS 侧;沿 generateTextureArrayGolden.mts 先例)。
 *
 * 单源 fixture:packages/deep-engine/fixtures/frame-abi/frame-v8-golden-parity-v1.json
 *   - TS 段:updatePbrFrameUniforms 真打包 96 字(words + sha256,f32 LE 字节序)。
 *   - Rust 段:占位 null,由 deep-engine-native::frame_v8_golden_parity_tests::regenerate_rust_golden_section
 *     (cargo test --ignored)以生产打包 frame_uniform + DirectionalLighting::apply 填充 596 字。
 * 双端测试读同一 fixture 逐字对拍;重跑本脚本即可让 TS 打包行为变化显式落进 git diff。
 *
 * 运行:仓库根 `node_modules/.bin/tsx packages/deep-engine/scripts/generateFrameV8GoldenParity.mts`
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CameraFrameHistory } from "../src/webgpu/cameraFrameHistory.js";
import { updatePbrFrameUniforms, type PbrFrameUniformResources, type PbrFrameUniformView } from "../src/webgpu/pbrFrameUniforms.js";
import { resolvePbrRendererFeatures, type PbrRendererFeatureOptions } from "../src/webgpu/pbrRendererFeatures.js";
import { resolvePbrSceneLighting, type PbrPrimaryDirectionalLight } from "../src/lighting/pbrSceneLighting.js";
import type { RtShadowRoute } from "../src/webgpu/rtShadowScheduling.js";
import { FRAME_ABI_SCHEMA_SHA256 } from "../src/frameAbi/generated/frameLayout.js";

interface GoldenCase {
  readonly id: string;
  readonly purpose: string;
  readonly directionalSource: { readonly directionWorld: readonly [number, number, number];
    readonly color: readonly [number, number, number]; readonly intensity: number; readonly castShadow: boolean };
  readonly view: PbrFrameUniformView;
  readonly width: number; readonly height: number; readonly forceCut: boolean; readonly frames: number;
  readonly featureOptions: PbrRendererFeatureOptions;
  readonly route: RtShadowRoute | null;
  readonly rust: { readonly aspect: number; readonly yaw: number;
    readonly extraLighting?: Record<string, unknown> };
}

/** 确定性三组:①基线(固定相机+单灯+默认 features)②全 features 开+第二帧(时域历史/jitter 差非零)+相机相对原点 ③边界(极端 near/far+cascade fail-closed+native 本地灯带)。 */
const CASES: GoldenCase[] = [
  {
    id: "baseline-single-light-default-features",
    purpose: "固定相机+单方向灯+DEFAULT features(经 resolvePbrRendererFeatures());首帧 cut,全部开关位走默认语义",
    directionalSource: { directionWorld: [-1.6, -2.8, -1.2], color: [2.5, 2.4, 2.25], intensity: 1, castShadow: true },
    view: { eye: [1, 2, 3], target: [0, 1, 0], extent: 4, background: [0.05, 0.06, 0.07],
      floor: [0.2, 0.21, 0.22], exposure: 1.25, roughness: 0.35 },
    width: 640, height: 480, forceCut: false, frames: 1,
    featureOptions: {},
    route: null,
    rust: { aspect: 640 / 480, yaw: 0.55 },
  },
  {
    id: "all-features-second-frame-camera-relative",
    purpose: "features 主要开关穷举(TAA/RT 阴影路由 ray-traced/环境/地面网格/雾/vignette/ACES)+第二帧(previousVP≠currentVP、jitterDeltaUv 非零)+cameraWorldPosition 相机相对路径;方向灯含零分量(借位台账 -0 保留语义)",
    directionalSource: { directionWorld: [0, -0.6, -0.8], color: [1, 0.75, 0.5], intensity: 2.5, castShadow: true },
    view: { eye: [1, 2, 3], target: [0, 1, 0], extent: 6, background: [0.01, 0.02, 0.03],
      floor: [0.1, 0.12, 0.14], exposure: 1.05, roughness: 0.6, colorGrading: "studio",
      environmentIntensity: 2.5, cameraWorldPosition: [0.25, 0.5, 0.75],
      verticalFovRadians: 1.1, near: 0.05, far: 300 },
    width: 1920, height: 1080, forceCut: false, frames: 2,
    featureOptions: { environment: true, fog: true, groundPlane: true, groundGrid: true,
      ambientOcclusion: true, screenSpaceReflection: true, temporalAa: true, spatialAa: true,
      visibilityBuffer: true, softRasterizeFallback: true, textureArrays: true, layeredMaterials: true,
      occlusionCulling: true, contactShadows: true, bloom: true, vignette: true,
      toneMapping: "three-aces-r185", rayTracedShadows: true, sdfGi: true, megaLights: true,
      rayTracedReflections: true },
    route: { channel: "ray-traced" },
    rust: { aspect: 1920 / 1080, yaw: -1.2, extraLighting: { globalIlluminationIntensity: 0.8 } },
  },
  {
    id: "boundary-extremes-cascade-fail-closed",
    purpose: "极端 near/far/fov+零背景零地面+environment/castShadow/groundGrid 全关(word 67/71/75=0)+cascade 选路压 RT 开关位(word 89=0 fail-closed)+deep-aces(word 91=0);native 侧带本地灯带(行 13 w=3 标记、软度/阴影视图/计数行)",
    directionalSource: { directionWorld: [0.6, -0.8, 0], color: [0.9, 0.9, 0.9], intensity: 0, castShadow: false },
    view: { eye: [0, 0.4, 0.9], target: [0, 0, 0], extent: 0.5, background: [0, 0, 0],
      floor: [0, 0, 0], exposure: 0.55, roughness: 0, verticalFovRadians: 2.8, near: 0.001, far: 100000 },
    width: 853, height: 477, forceCut: true, frames: 1,
    featureOptions: { environment: false, fog: true, groundPlane: false, groundGrid: false,
      ambientOcclusion: false, temporalAa: true, spatialAa: false, contactShadows: false,
      occlusionCulling: false, bloom: false, vignette: false, toneMapping: "deep-aces",
      rayTracedShadows: true },
    route: { channel: "cascade", reason: "adaptive-shadow-tier-performance" },
    rust: { aspect: 853 / 477, yaw: 2.8, extraLighting: { localLights: [
      { kind: "spot", position: [0, 4, 0], direction: [0, -1, 0], radiance: [1, 1, 1], range: 12,
        decay: 2, innerCos: 0.9, outerCos: 0.7, shadowSoftness: 0.25, castShadow: true },
      { kind: "point", position: [2, 3, -1], direction: [0, -1, 0], radiance: [0.5, 0.5, 0.5],
        range: 8, decay: 2, innerCos: 1, outerCos: 0, castShadow: true },
    ] } },
  },
];

const stubQueue = { writeBuffer: () => undefined } as unknown as GPUQueue;

const sha256OfWords = (words: readonly number[]): string =>
  createHash("sha256").update(Buffer.from(Float32Array.from(words).buffer)).digest("hex");

function packTs(envelope: GoldenCase, primary: PbrPrimaryDirectionalLight,
  features: ReturnType<typeof resolvePbrRendererFeatures>): { words: number[]; sha256: string } {
  const resources: PbrFrameUniformResources = {
    frameBuffer: {} as GPUBuffer, outputBuffer: {} as GPUBuffer, groundInstance: {} as GPUBuffer,
    frameData: new Float32Array(96), outputData: new Float32Array(8), groundData: new Float32Array(36),
  };
  const history = new CameraFrameHistory();
  for (let index = 0; index < envelope.frames; index++) {
    const result = updatePbrFrameUniforms(stubQueue, history, envelope.view, envelope.width,
      envelope.height, index === 0 && envelope.forceCut, resources, primary, features,
      envelope.route ?? undefined);
    history.commitFrame(result.history);
  }
  const words = Array.from(resources.frameData);
  return { words, sha256: sha256OfWords(words) };
}

const fixture = {
  fixtureSchema: "deep-monkey.frame-v8-golden-parity.v1",
  frameAbiSchemaSha256: FRAME_ABI_SCHEMA_SHA256,
  // 字节口径:sha256 对 words 数组的 f32 little-endian 序列(96 字=384B / 596 字=2384B)计算;
  // JSON 数字为 f32 精确往返(double shortest-repr ↔ f32 无损),双端逐字比较用全等。
  byteForm: "sha256(f32-le(words)); numbers are exact f32 round-trips",
  conventions: {
    // schema coreFields 中声明双端同语义的 5 段;相机三段仅布局锚,逐值对拍只在共享输入驱动段。
    lightDirection: "coreField(ts word 76..79 ↔ rust row 11):适配层把 TS surfaceToLightWorld(to-light)直喂 rust DirectionalLighting.direction 后,两端 xyz 打包值全等(TS BRDF 与 native shader 同以 lightDirection.xyz 为指向光向量);它与作者 world light 的 travel directionWorld 相差一个符号(TS 零保留取反)。w 双语义:ts=environmentIntensity(0..64),rust=0(遗留闲道)",
    sunColor: "coreField(ts word 84..87 ↔ rust row 13):rgb 全等;w 双语义:ts=作者 intensity,rust=2(作者灯标记)/3(作者灯+本地灯)",
    exposure: "补充观测关系(非 coreField):ts word 88 == rust row 14 word 0;rust row 14=[exposure,shadows,本地灯数,阴影视图数]",
    camera: "viewProjection/lightViewProjection/eye(ts 0/48/64 ↔ rust row 0/4/8)仅布局锚:双端相机模型不同(demo 轨道相机 vs 自由透视),按设计不做逐值对拍——schema 注记与 generated 常量为准",
    negativeZero: "-0.0 以字面 -0 序列化(JSON.stringify 会丢符号):逐字节 golden 保留 f32 符号位,双端 SHA-256 与逐字比较都区分 -0/+0",
  },
  cases: CASES.map(envelope => {
    const primary = resolvePbrSceneLighting({ directional: [envelope.directionalSource] }).primary;
    const features = resolvePbrRendererFeatures(envelope.featureOptions);
    const packed = packTs(envelope, primary, features);
    return {
      id: envelope.id, purpose: envelope.purpose,
      inputs: {
        ts: { view: envelope.view, width: envelope.width, height: envelope.height,
          forceCut: envelope.forceCut, frames: envelope.frames,
          primaryLight: { rayDirectionWorld: [...primary.rayDirectionWorld],
            surfaceToLightWorld: [...primary.surfaceToLightWorld], color: [...primary.color],
            intensity: primary.intensity, castShadow: primary.castShadow === true },
          features, route: envelope.route },
        rust: { aspect: envelope.rust.aspect, yaw: envelope.rust.yaw,
          directionalLighting: { direction: [...primary.surfaceToLightWorld],
            radiance: [...envelope.directionalSource.color], exposure: envelope.view.exposure,
            shadows: envelope.directionalSource.castShadow, ...envelope.rust.extraLighting } },
      },
      ts: { floats: 96, words: packed.words, sha256: packed.sha256 },
      rust: { floats: 596, words: null, sha256: null },
    };
  }),
};

const outDir = resolve(import.meta.dirname ?? ".", "../fixtures/frame-abi");
mkdirSync(outDir, { recursive: true });
const out = resolve(outDir, "frame-v8-golden-parity-v1.json");
// JSON.stringify 丢 -0 符号(replacer 无从干预数字字面量),先以哨兵串占位再还原为 -0 字面量;
// JSON.parse("-0") === -0,Rust serde_json 同样保符号——逐字节 golden 双端无损。
const serialized = JSON.stringify(fixture, (_key, value) => Object.is(value, -0) ? "__NEGZERO__" : value, 1)
  .replaceAll("\"__NEGZERO__\"", "-0");
writeFileSync(out, `${serialized}\n`);
console.log(`wrote ${out}`);
for (const entry of fixture.cases) {
  console.log(`  ${entry.id}: ts.sha256=${entry.ts.sha256} rust=${entry.rust.words === null ? "PENDING native fill (cargo test frame_v8_golden -- --ignored)" : "filled"}`);
}
