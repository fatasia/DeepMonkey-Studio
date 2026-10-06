/**
 * P1 质量主线(六引擎对标刀位 2):native MegaLights 万灯直接光 RIS 双端对拍
 * fixture 生成器(TS 侧)。
 *
 * 单源 fixture:packages/deep-engine/fixtures/megalights-native-parity-v1.json
 *   - TS 段:packMegaLights(灯池 64B ABI)+ buildReservoirPassCpu(趟一)+
 *     reuseAndShadePassCpu(趟二)+ megaLightsExhaustiveReferenceCpu(穷举参考)
 *     的生产 CPU 权威输出(f32 词 + sha256 + f64 蓄水池标量)。
 *   - Rust 段:无占位 —— native 镜像(megalights_ris)从 inputs 段重算并与 TS 段
 *     对拍(deep-engine-native::megalights_parity_tests)。
 * 重跑本脚本即可让 TS 权威行为变化显式落进 git diff。
 *
 * 黄金场景(8×6 像素 × 12 灯,数值设计避开采样比较边界):
 *   - 灯:5 点(decay 2/2/3/2/2.5,range 窗口混合)+ 4 聚(含 inner==outer
 *     coneScale=0 分支;spot 0/1/2 携带 IES 行号 0/1/2,spot 3 无 IES)+
 *     3 矩形面积(单面/双面/朝向剔除);
 *   - IES(2026-10-06):两个 LM-63 profile(对称 2/4),packIesShading 打包字节
 *     与 evaluateIesShadingFactor 因子向量入 fixture;帧 43 无 IES(恒等分支);
 *   - 表面:平面行(normal [0,1,0] 精确单位)+ 柱面尾行(normal [±0.6,0.8,0]
 *     精确,驱动空间法线门失败分支)+ 前景/背景深度断裂(2.0/4.0,驱动时域/空间
 *     深度门分支)+ metallic/roughness 变化;
 *   - 帧:0 首帧全量替换 → 1 时域+EMA(motion 0.25)→ 2 spatial 关 →
 *     3 temporal 关 → 4 穷举;另附独立穷举精确参考;
 *   - 胜者可见性(2026-10-06):x=-0.75 竖墙两级 TLAS 场景,mask 真值 =
 *     traceTlasClosest(frame 0 胜者射线,origin 外推 + tMax 双侧收缩)。
 *
 * 运行:仓库根 `node_modules/.bin/tsx packages/deep-engine/scripts/generateMegaLightsNativeParity.mts`
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { packIesShading, evaluateIesShadingFactor, type PackedIesShading } from "../src/lighting/iesShading.js";
import { packMegaLights, type MegaLight } from "../src/lighting/megaLights.js";
import {
  buildReservoirPassCpu,
  megaLightsExhaustiveReferenceCpu,
  reuseAndShadePassCpu,
  type MegaLightsFrameConfig,
  type MegaLightsFrameInput,
  type RisReservoir,
} from "../src/lighting/megaLightsRisCpu.js";
import type { LightVector3 } from "../src/lighting/types.js";
import type { SpotLight } from "../src/lighting/types.js";
import type { RuntimeLightProfile } from "../src/runtimePackage/environmentTypes.js";
import { buildTlas, traceTlasClosest } from "../src/rayTracing/tlas.js";
import type { RayBlasDescriptor } from "../src/rayTracing/rayBackendTypes.js";

const sha256OfWords = (words: ArrayLike<number>): string =>
  createHash("sha256").update(Buffer.from(Float32Array.from(words).buffer)).digest("hex");
const wordsOf = (values: ArrayLike<number>): number[] => Array.from(values, value => value);
const f64Json = (values: readonly number[]): number[] => [...values];

const WIDTH = 8;
const HEIGHT = 6;

// ===== 黄金场景:与 native 镜像单测(megalights_ris::tests::golden_*)同源同式,
// 数值逐字一致 —— parity 对拍由 fixture inputs 驱动,两份拷贝漂移即红。=====

const goldenLights = (): MegaLight[] => {
  const point = (position: LightVector3, range: number, intensity: number, decay: number): MegaLight =>
    ({ kind: "point", positionView: position, range, color: [1.0, 0.9, 0.8], intensity, decay });
  const spot = (position: LightVector3, inner: number, outer: number, iesSpotIndex?: number): MegaLight =>
    ({ kind: "spot", positionView: position, range: 8.0, color: [0.9, 0.6, 1.0], intensity: 6.0,
      decay: 2.0, directionView: [0.0, -1.0, 0.0], innerConeCos: inner, outerConeCos: outer,
      ...(iesSpotIndex === undefined ? {} : { iesSpotIndex }) });
  return [
    point([1.0, 3.0, 0.0], 0.0, 4.0, 2.0),
    point([-2.0, 2.5, 1.0], 10.0, 3.0, 2.0),
    point([3.0, 4.0, -1.0], 5.0, 2.0, 3.0),
    point([0.0, 6.0, 2.0], 0.0, 1.5, 2.0),
    point([-1.0, 2.0, 3.0], 4.0, 5.0, 2.5),
    spot([0.5, 4.0, 0.0], 0.9, 0.5, 0),
    spot([-1.5, 5.0, 1.0], 0.8, 0.8, 1), // inner == outer → coneScale = 0 分支
    spot([2.0, 3.5, 2.0], 0.95, 0.3, 2),
    spot([1.0, 2.0, -2.0], 0.7, 0.2), // 无 IES:参数行 3 = -1(恒等分支)
    { kind: "area", positionView: [0.0, 5.0, 0.0], range: 0.0, color: [1.0, 1.0, 1.0], intensity: 2.0,
      decay: 2.0, directionView: [0.0, -1.0, 0.0], upView: [0.0, 0.0, 1.0], halfExtent: [0.5, 0.25] },
    { kind: "area", positionView: [-2.0, 4.0, 1.0], range: 12.0, color: [0.5, 0.8, 1.0], intensity: 3.0,
      decay: 2.0, directionView: [0.0, -1.0, 0.0], upView: [0.0, 0.0, 1.0], halfExtent: [0.75, 0.5], twoSided: true },
    { kind: "area", positionView: [3.0, 2.0, 0.0], range: 6.0, color: [1.0, 0.4, 0.2], intensity: 4.0,
      decay: 2.0, directionView: [0.0, -1.0, 0.0], upView: [0.0, 0.0, 1.0], halfExtent: [0.25, 0.25] },
  ];
};

// ===== IES 场景(2026-10-06 native IES 注入切片):两个 LM-63 profile(对称 2/4)、
// 行距 90°/值域跨度大(因子 0.03~0.9),spot 0/1 共享 profile A(rotation 0/45、scale
// 1/0.8),spot 2 用 profile B(scale 1.5),spot 3 无 ies(参数行 -1 恒等分支)。
// 行号合同与 megaLightsFromClustered 一致:iesSpotIndex = spot 序号。=====

const goldenIesProfiles = (): RuntimeLightProfile[] => [
  {
    profileId: "ies-golden-mirror",
    format: "LM-63-2002",
    verticalAngles: [0, 10, 25, 45, 70, 90],
    candela: [
      [60, 200, 500, 900, 400, 100],
      [80, 300, 800, 1000, 500, 150],
      [100, 400, 900, 700, 300, 80],
      [120, 500, 1000, 600, 200, 50],
      [150, 600, 900, 500, 150, 30],
    ],
    horizontalSymmetry: 2,
    totalLumens: 12_000,
  },
  {
    profileId: "ies-golden-quad",
    format: "LM-63-1995",
    verticalAngles: [0, 20, 40, 60, 80, 90],
    candela: [
      [900, 1000, 700, 350, 120, 40],
      [850, 950, 650, 300, 100, 30],
      [800, 900, 600, 250, 80, 20],
    ],
    horizontalSymmetry: 4,
    totalLumens: 9_000,
  },
];

/** packIesShading 的 spot 形参(行 = spot 序号;仅消费 ies 字段,其余字段按
 * golden spot 同值补齐满足类型)。 */
const goldenSpotLightsForIes = (lights: readonly MegaLight[]): SpotLight[] =>
  lights.filter(light => light.kind === "spot").map(light => ({
    positionView: light.positionView,
    range: light.range,
    color: light.color,
    intensity: light.intensity,
    directionView: light.directionView!,
    innerConeCos: light.innerConeCos!,
    outerConeCos: light.outerConeCos!,
    ...(light.iesSpotIndex === 0 ? { ies: { profileId: "ies-golden-mirror" } } : {}),
    ...(light.iesSpotIndex === 1 ? { ies: { profileId: "ies-golden-mirror", rotationDeg: 45, scaleFactor: 0.8 } } : {}),
    ...(light.iesSpotIndex === 2 ? { ies: { profileId: "ies-golden-quad", scaleFactor: 1.5 } } : {}),
  }));

type SurfaceRow = readonly (readonly (number | LightVector3))[];

const goldenSurfaces = (): SurfaceRow[] => {
  const surfaces: SurfaceRow[] = [];
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const foreground = x < WIDTH / 2;
      const depth = foreground ? 2.0 : 4.0;
      const cylinderRow = y === HEIGHT - 1;
      const normal: LightVector3 = cylinderRow
        ? (x % 2 === 0 ? [0.6, 0.8, 0.0] : [-0.6, 0.8, 0.0])
        : [0.0, 1.0, 0.0];
      const position: LightVector3 = [x * 0.5 - WIDTH * 0.25, depth, y * 0.5 - HEIGHT * 0.25];
      surfaces.push([
        [position[0], position[1], position[2], (x + y) % 3 === 0 ? 1.0 : 0.0],
        [normal[0], normal[1], normal[2], (x * 7 + y) % 2 === 0 ? 0.45 : 0.2],
        [0.8, 0.7, 0.6, 0.0],
      ]);
    }
  }
  return surfaces;
};

const lights = goldenLights();
const surfaces = goldenSurfaces();
const packed = packMegaLights(lights);
const iesProfiles = goldenIesProfiles();
const iesPacking: PackedIesShading = packIesShading(goldenSpotLightsForIes(lights), iesProfiles);

const pixels = WIDTH * HEIGHT;
const motion = Array.from({ length: pixels * 2 }, () => 0.25);
const visibility = Array.from({ length: pixels }, (_, index) => (index % 7 === 3 ? 0.0 : 1.0));

interface FrameSpec {
  frame: number;
  exhaustive: boolean;
  spatial: boolean;
  temporal: boolean;
  withMotion: boolean;
  withVisibility: boolean;
  /** 帧级 IES 供给(2026-10-06;false 帧 = 恒等分支,链上 IES 帧→无 IES 帧的
   * 时域衔接由蓄水池重评价自然吸收)。 */
  withIes: boolean;
}

const frameSpecs: FrameSpec[] = [
  { frame: 40, exhaustive: false, spatial: true, temporal: true, withMotion: false, withVisibility: true, withIes: true },
  { frame: 41, exhaustive: false, spatial: true, temporal: true, withMotion: true, withVisibility: true, withIes: true },
  { frame: 42, exhaustive: false, spatial: false, temporal: true, withMotion: true, withVisibility: true, withIes: true },
  { frame: 43, exhaustive: false, spatial: true, temporal: false, withMotion: true, withVisibility: false, withIes: false },
  { frame: 44, exhaustive: true, spatial: true, temporal: true, withMotion: false, withVisibility: true, withIes: true },
];

const runFrame = (
  spec: FrameSpec,
  previous: readonly RisReservoir[] | undefined,
  previousColor: Float32Array | undefined,
): { reservoirs: RisReservoir[]; built: RisReservoir[]; color: Float32Array } => {
  const config: MegaLightsFrameConfig = {
    width: WIDTH,
    height: HEIGHT,
    temporal: spec.temporal,
    spatial: spec.spatial,
    exhaustive: spec.exhaustive,
  };
  const input: MegaLightsFrameInput = {
    lights,
    surfaces,
    ...(previous === undefined ? {} : { previous }),
    ...(spec.withMotion ? { motionUv: motion } : {}),
    ...(previousColor === undefined ? {} : { previousColor }),
    ...(spec.withVisibility ? { visibility } : {}),
    ...(spec.withIes ? { ies: iesPacking } : {}),
    frame: spec.frame,
    config,
  };
  const built = buildReservoirPassCpu(input);
  const output = reuseAndShadePassCpu(input, built);
  return { reservoirs: [...output.reservoirs], built, color: output.color };
};

// 帧间依赖链:previous/previousColor 取上一帧真实输出(时域蓄水池 + 颜色 EMA)。
interface FrameResult {
  spec: FrameSpec;
  reservoirs: RisReservoir[];
  built: RisReservoir[];
  color: Float32Array;
}
const frames: FrameResult[] = [];
frameSpecs.forEach((spec, index) => {
  const previous = index === 0 ? undefined : frames[index - 1]!.reservoirs;
  const previousColor = index === 0 ? undefined : frames[index - 1]!.color;
  frames.push({ spec, ...runFrame(spec, previous, previousColor) });
});

// 穷举精确参考(帧 44 withIes = true,同口径消费 IES;与 WGSL 穷举分支一致)。
const exhaustiveReference = megaLightsExhaustiveReferenceCpu(lights, surfaces, WIDTH, HEIGHT, iesPacking);

// 50 个独立帧种子的逐像素均值(TS 权威统计腿;native 同口径重放对拍——
// K=32 单帧在 HDR 灯跨度下方差大,均值域才是跨端可比的统计收敛域)。
const SEEDS = 50;
const seedMean = new Float64Array(WIDTH * HEIGHT * 3);
for (let seed = 0; seed < SEEDS; seed++) {
  const config: MegaLightsFrameConfig = {
    width: WIDTH, height: HEIGHT, temporal: false, spatial: true, exhaustive: false,
  };
  const input: MegaLightsFrameInput = { lights, surfaces, ies: iesPacking, frame: 1000 + seed, config };
  const output = reuseAndShadePassCpu(input, buildReservoirPassCpu(input));
  for (let index = 0; index < output.color.length; index++) seedMean[index] += output.color[index]! / SEEDS;
}

// ---- IES 因子向量黄金腿(2026-10-06):evaluateIesShadingFactor 的真值向量,
// native 位级对拍(因子 = f32 展开值 × f32 scale 的 f64 乘积,双端精确;
// 角度经 0.5° 网格量化吸收 acos/atan2 ULP,向量取值避开半度中点)。----
interface IesFactorVector { spotIndex: number; lightDirection: LightVector3; surfaceToLight: LightVector3; factor: number }

const iesFactorVectors = (): IesFactorVector[] => {
  const spot = (index: number) => lights.filter(candidate => candidate.kind === "spot")[index]!;
  const surfaceToLightFrom = (pixel: number): LightVector3 => {
    const [px, py, pz] = surfaces[pixel]![0] as readonly number[];
    const light = spot(0);
    const dx = light.positionView[0] - px!, dy = light.positionView[1] - py!, dz = light.positionView[2] - pz!;
    const length = Math.hypot(dx, dy, dz);
    return [dx / length, dy / length, dz / length];
  };
  const vector = (spotIndex: number, surfaceToLight: LightVector3): IesFactorVector => {
    const light = spot(spotIndex);
    const directionLength = Math.hypot(...(light.directionView ?? [0, 0, 1]));
    const lightDirection: LightVector3 = (light.directionView ?? [0, 0, 1]).map(component => component / directionLength) as LightVector3;
    return { spotIndex, lightDirection, surfaceToLight,
      factor: evaluateIesShadingFactor(iesPacking, spotIndex, lightDirection, surfaceToLight) };
  };
  return [
    vector(0, surfaceToLightFrom(0)),
    vector(0, surfaceToLightFrom(9)),
    vector(0, surfaceToLightFrom(20)),
    vector(0, surfaceToLightFrom(41)),
    vector(1, surfaceToLightFrom(3)),
    vector(1, surfaceToLightFrom(30)),
    vector(2, surfaceToLightFrom(5)),
    vector(2, surfaceToLightFrom(33)),
    vector(2, surfaceToLightFrom(12)),
    vector(3, surfaceToLightFrom(7)), // 无 ies 行 → 恒等 1
    // 角域外(θ > 90°,表面在灯上方):合同性 0,不外推。
    vector(0, [0, -1, 0]),
  ];
};

// ---- 胜者可见性射线场景(2026-10-06 native 可见性档切片):两级 TLAS 遮挡的
// fixture 黄金腿。世界空间 = 视空间(viewToWorld = identity);遮挡物 = x=-0.75
// 竖墙(y∈[1.5,4.5], z∈[-2.5,2.5];边界外扩 0.5 防黄金射线擦棱边——像素级 f32/f64
// 边界噪声会把擦边命中判成两端分歧),截断部分表面→胜者灯连线:mask 由胜者分布
// 决定,同时覆盖可见/遮挡/无效胜者(→1)三分支。mask 真值 = TS 权威
// traceTlasClosest(GPU 两级追踪的仲裁基准,boolean 语义无跨 libm 面);射线构造与
// GPU deepMegaWriteWinnerRay 同式(origin 外推 + tMax 双侧收缩,相对偏移 1e-3)。----
const MEGA_LIGHTS_VISIBILITY_RAY_BIAS_RELATIVE = 1e-3;

const visibilityOccluder = {
  id: 0,
  mask: 0xffffffff,
  worldToLocal: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0] as readonly [number, number, number, number, number, number, number, number, number, number, number, number],
  vertices: [
    -0.75, 1.5, -2.5,
    -0.75, 1.5, 2.5,
    -0.75, 4.5, 2.5,
    -0.75, 4.5, -2.5,
  ],
  indices: [0, 1, 2, 0, 2, 3],
};

const winnerVisibilityMask = (): number[] => {
  const blas: RayBlasDescriptor = {
    id: "golden-occluder",
    vertices: Float32Array.from(visibilityOccluder.vertices),
    indices: Uint32Array.from(visibilityOccluder.indices),
  };
  const tlas = buildTlas([{
    id: `instance-${visibilityOccluder.id}`,
    blas,
    worldToLocal: visibilityOccluder.worldToLocal,
    mask: visibilityOccluder.mask,
  }]);
  const built = frames[0]!.built;
  const mask: number[] = [];
  for (let pixel = 0; pixel < pixels; pixel++) {
    const winner = built[pixel]!.winner;
    if (winner === 0xffffffff) { mask.push(1); continue; }
    const [px, py, pz] = surfaces[pixel]![0] as readonly number[];
    const light = lights[winner]!;
    const dx = light.positionView[0] - px!, dy = light.positionView[1] - py!, dz = light.positionView[2] - pz!;
    const distance = Math.hypot(dx, dy, dz);
    if (!(distance > 0)) { mask.push(1); continue; }
    const ux = dx / distance, uy = dy / distance, uz = dz / distance;
    const epsilon = distance * MEGA_LIGHTS_VISIBILITY_RAY_BIAS_RELATIVE;
    const hit = traceTlasClosest(tlas, {
      ox: px! + ux * epsilon, oy: py! + uy * epsilon, oz: pz! + uz * epsilon,
      dx: ux, dy: uy, dz: uz,
      tMax: distance - epsilon - epsilon,
    });
    mask.push(hit === undefined ? 1 : 0);
  }
  return mask;
};

const serializeReservoir = (reservoir: RisReservoir): [number, number, number] =>
  [reservoir.weightSum, reservoir.winner, reservoir.m];

const fixture = {
  fixtureSchema: "megalights-native-parity-v1",
  generator: "packages/deep-engine/scripts/generateMegaLightsNativeParity.mts",
  nativeTwin: "packages/deep-engine-native/src/megalights_parity_tests.rs",
  tolerance: {
    // 镜像按 f64 中间量逐式同构;RNG(u32 整数流)/蓄水池结构(winner/m)/门逻辑
    // 对拍位级。唯跨 libm 数学(hypot/pow/exp2)在单灯评价内逐次出现 → ①蓄水池
    // f64 标量相对 ≤1e-9(sdf-gi scalarRel 同款);②胜者序列仍位级(场景取值
    // 避开 uniform×total 比较边界);③f32 color 词 ≤2 ulp(链式 1e-9 传播后
    // 落点翻转的 1 ulp 裕度 ×2);④灯池打包词位级(纯算术+normalize hypot 哨兵
    // → 归一化分量相对 ≤1e-9 后 f32 落点允许 1 ulp)。
    scalarRel: 1e-9,
    colorWordUlp: 2,
    packedWordUlp: 1,
  },
  inputs: {
    width: WIDTH,
    height: HEIGHT,
    risCandidates: 32,
    spatialRadius: 2,
    temporalDepthGate: 0.1,
    spatialNormalGate: 0.9,
    alphaBlend: null, // 缺省 1/32;镜像同取缺省。
    motion: frames.some(({ spec }) => spec.withMotion) ? motion : null,
    visibility: frames.some(({ spec }) => spec.withVisibility) ? visibility : null,
    // E02 IES 打包载荷(vec4 字流;native 从同一份字节评测因子,与 GPU binding 8 同源)。
    iesPacked: wordsOf(iesPacking.data),
    iesSpotCount: iesPacking.spotCount,
    lights: lights.map(light => ({
      kind: light.kind,
      positionView: f64Json(light.positionView),
      range: light.range,
      color: f64Json(light.color),
      intensity: light.intensity,
      decay: light.decay,
      directionView: light.directionView === undefined ? null : f64Json(light.directionView),
      innerConeCos: light.innerConeCos ?? null,
      outerConeCos: light.outerConeCos ?? null,
      halfExtent: light.halfExtent === undefined ? null : [...light.halfExtent],
      upView: light.upView === undefined ? null : f64Json(light.upView),
      twoSided: light.twoSided === undefined ? null : light.twoSided,
      iesSpotIndex: light.iesSpotIndex === undefined ? null : light.iesSpotIndex,
    })),
    surfaces: surfaces.map(surface => surface.map(vec4 => f64Json([...vec4] as number[]))),
  },
  packed: {
    data: wordsOf(packed.data),
    sha256: sha256OfWords(packed.data),
    count: packed.count,
    pointCount: packed.pointCount,
    spotCount: packed.spotCount,
    areaCount: packed.areaCount,
    iesReferenceCount: packed.iesReferenceCount,
  },
  iesFactorVectors: iesFactorVectors(),
  winnerVisibility: {
    frameIndex: 0,
    viewToWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    rayMask: 0xffffffff,
    biasRelative: MEGA_LIGHTS_VISIBILITY_RAY_BIAS_RELATIVE,
    occluder: visibilityOccluder,
    maskGolden: winnerVisibilityMask(),
  },
  frames: frames.map(({ spec, built, reservoirs, color }) => ({
    frame: spec.frame,
    exhaustive: spec.exhaustive,
    spatial: spec.spatial,
    temporal: spec.temporal,
    withMotion: spec.withMotion,
    withVisibility: spec.withVisibility,
    withIes: spec.withIes,
    built: built.map(serializeReservoir),
    reservoirs: reservoirs.map(serializeReservoir),
    colorWords: wordsOf(color),
    colorSha256: sha256OfWords(color),
  })),
  exhaustiveReference: {
    colorWords: wordsOf(exhaustiveReference),
    colorSha256: sha256OfWords(exhaustiveReference),
  },
  seedAveraged: {
    seeds: SEEDS,
    // f64 均值全精度序列化(JSON number 最短往返 = 双端无损)。
    mean: Array.from(seedMean, value => value),
  },
};

const outPath = resolve(import.meta.dirname!, "../fixtures/megalights-native-parity-v1.json");
// JSON.stringify 丢 -0 符号(frame v8 / sdf-gi 同款教训):先以哨兵串占位再还原为
// -0 字面量;JSON.parse("-0") === -0,Rust serde_json 同样保符号。
const serialized = JSON.stringify(fixture, (_key, value) => Object.is(value, -0) ? "__NEGZERO__" : value, 2)
  .replaceAll("\"__NEGZERO__\"", "-0") + "\n";
writeFileSync(outPath, serialized, "utf8");
console.log(`megalights native parity fixture written: ${outPath}`);
console.log(`frames=${frames.length} pixels=${pixels} lights=${lights.length} color sha256=${fixture.frames[1]!.colorSha256}`);
