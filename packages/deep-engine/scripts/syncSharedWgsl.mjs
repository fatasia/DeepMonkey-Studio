// WGSL 单源(试点)同步器:唯一真源是 packages/deep-engine/wgsl/ 下的 .wgsl 文件,
// 本脚本从真源生成(a)TS 镜像模块、(b)SHA-256 校验和夹具(“<hex> <byteLen>”单行)。
// Rust 侧不经本脚本——deep-engine-native/src/probe_gi_wgsl.rs 用 include_str! 直接引用真源。
//
// 为什么 TS 侧是“生成镜像”而不是 ?raw 直读:根入口 src/index.ts `export * from "./lighting/index.js"`
// 使 WGSL 模块进入 apps/api 的 node/tsx 消费链,而 `?raw` 仅 Vite/vitest 支持;
// 镜像由 JSON.stringify 逐字节转写,运行时仍是普通 TS 字符串(node/dist/tsx 全兼容),
// 字节一致性由 probeClipmapSamplingWgslChecksum.test.ts(staleness + checksum)与 Rust 半对拍守护。
//
// 修改 WGSL 的流程:改 wgsl/<name>.wgsl → `pnpm --filter @bim-studio/deep-engine wgsl:sync`
// → 提交 .wgsl + 生成模块 + .sha256 夹具(三者不同步时 TS/Rust 两半测试都会失败)。
// 推广新 WGSL 家族:把文件放入 wgsl/ 并在 SHARED_WGSL 登记一项。
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wgslRoot = resolve(packageRoot, "wgsl");

/** 单源登记表:真源 .wgsl → 生成目标。 */
const SHARED_WGSL = [
  {
    source: "probeClipmapSampling.wgsl",
    module: resolve(packageRoot, "src/lighting/probeClipmapSamplingWgsl.ts"),
    // ABI 常量与真源插值点的字面一致性由 probeClipmapSamplingWgslChecksum.test.ts 守护。
    gate: "src/lighting/probeClipmapSamplingWgslChecksum.test.ts",
    rustHalf: "deep-engine-native/src/probe_gi_wgsl.rs",
    constants: `export const DEEP_GI_SAMPLING_ABI_VERSION = 1;
export const DEEP_GI_SAMPLING_BIND_GROUP = 3;
export const DEEP_GI_PROBE_STORAGE_BINDING = 9;
export const DEEP_GI_LEVEL_METADATA_BINDING = 10;
export const DEEP_GI_PROBES_PER_LEVEL_SAMPLE = 8;
export const DEEP_GI_MAX_LEVEL_SAMPLE_COUNT = 2;
export const DEEP_GI_MAX_PROBE_FETCHES = 16;
export const DEEP_GI_CASCADE_BLEND_CELLS = 1.5;
export const DEEP_GI_NORMAL_BIAS_CELLS = 0.2;
/** DDGI 法线权重陡峭度：越大越抑制斜向（背面）探针，是泄漏抑制的主控参数。 */
export const DEEP_GI_NORMAL_WEIGHT_BIAS = 3;
export const DEEP_GI_MIN_SAMPLE_WEIGHT = 0.001;
`,
    preamble: `/** Read-only group-3 library; resource binding is deferred until the GI renderer slice. */\nexport const PROBE_CLIPMAP_SAMPLING_WGSL = /* wgsl */ `,
  },
  {
    // J2-B1 家族一:介电 F0。文件内容 = 既有 MATERIAL_DIELECTRIC_WGSL 导出串逐字节
    // (首行换行是原模板字面量的一部分,字节冻结——pbrShader.ts 用本串对
    // EXTENDED_MATERIAL_EVALUATION_WGSL 做 .replace() 手术,字节漂移会静默漏替换)。
    source: "materialDielectric.wgsl",
    module: resolve(packageRoot, "src/lighting/materialDielectricWgsl.ts"),
    gate: "src/lighting/materialDielectricWgslChecksum.test.ts",
    rustHalf: "deep-engine-native/src/lighting_math_wgsl.rs",
    constants: `/**
 * J2-B1 介电 F0 家族(灯光数学三件套之一)的生成镜像。唯一真源 wgsl/materialDielectric.wgsl,
 * Rust 半在 deep-engine-native/src/lighting_math_wgsl.rs(bin 侧 frame_bindings 经 concat! 拼进
 * native mesh shader 真实消费)。再导出入口:src/materialDielectric.ts(既有 import 路径不变)。
 */`,
    preamble: `export const MATERIAL_DIELECTRIC_WGSL = /* wgsl */ `,
  },
  {
    // J2-B1 家族二:直射 BRDF(GGX + 相关 Smith + Schlick)。文件内容 = PBR_DIRECT_LIGHTING_WGSL
    // 去掉首行换行与介电块后的余部;组合恒等式
    // PBR_DIRECT_LIGHTING_WGSL === "\\n" + MATERIAL_DIELECTRIC_WGSL + "\\n" + 本文件
    // 由 brdfDirectLightingWgslChecksum.test.ts 逐字节锁定。引用 safeNormalize 由宿主提供
    // (native mesh 侧有同名适配别名)。
    source: "brdfDirectLighting.wgsl",
    module: resolve(packageRoot, "src/lighting/brdfDirectLightingWgsl.ts"),
    gate: "src/lighting/brdfDirectLightingWgslChecksum.test.ts",
    rustHalf: "deep-engine-native/src/lighting_math_wgsl.rs",
    constants: `/**
 * J2-B1 直射 BRDF 家族的生成镜像。唯一真源 wgsl/brdfDirectLighting.wgsl,
 * Rust 半在 deep-engine-native/src/lighting_math_wgsl.rs(bin 侧 frame_bindings 经 concat! 拼进
 * native mesh shader 真实消费)。高光乘法次序 \`f * visibility * distribution\` 是 TS 权威序
 * (白炉验收基准;native 原实现为 distribution 起乘,B1 已对齐,漂移记录见任务报告)。
 */`,
    preamble: `export const PBR_BRDF_DIRECT_LIGHTING_WGSL = /* wgsl */ `,
  },
  {
    // J2-B1 家族三:IES 光域网采样。文件内容 = FORWARD_PLUS_PBR_WGSL 中
    // "const DEEP_IES_RAD_TO_DEG" 起、deepClusterSafeNormalize 前止的连续区段
    // (常量 + 合同注释 + deepSpotIesFactor;原 TS 插值 ${IES_TABLE_ROW_STRIDE_VEC4}u
    // 已固化为 91u 字面量,字面值与 iesShading.ts 常量的锁定在 checksum 测试)。
    // 末尾带换行,TS 侧组合用同行拼接保持 FORWARD_PLUS_PBR_WGSL 逐字节不变。
    source: "iesSampling.wgsl",
    module: resolve(packageRoot, "src/lighting/iesSamplingWgsl.ts"),
    gate: "src/lighting/iesSamplingWgslChecksum.test.ts",
    rustHalf: "deep-engine-native/src/lighting_math_wgsl.rs",
    constants: `/**
 * J2-B1 IES 光域网采样家族的生成镜像。唯一真源 wgsl/iesSampling.wgsl,
 * Rust 半在 deep-engine-native/src/lighting_math_wgsl.rs(bin 侧 frame_bindings 经 concat! 拼进
 * native mesh shader 真实消费;binding 9 的 storage 变量随源内符号统一为 deepIesShading)。
 */`,
    preamble: `export const DEEP_IES_SAMPLING_WGSL = /* wgsl */ `,
  },
  {
    // C3 矩形/带纹理面积光(LTC)家族。真源 wgsl/ltcAreaLighting.wgsl,
    // Rust 半在 deep-engine-native/src/lighting_math_wgsl.rs(include_str! + 夹具对拍;
    // native 无运行时通路,消费面 = WGSL 单源指纹 + ltc_area_light.rs f64 参考)。
    source: "ltcAreaLighting.wgsl",
    module: resolve(packageRoot, "src/lighting/ltcAreaLightingWgsl.ts"),
    gate: "src/lighting/ltcAreaLightingWgslChecksum.test.ts",
    rustHalf: "deep-engine-native/src/lighting_math_wgsl.rs",
    constants: `/**
 * C3 面积光 LTC 家族的生成镜像。唯一真源 wgsl/ltcAreaLighting.wgsl,
 * Rust 半在 deep-engine-native/src/lighting_math_wgsl.rs;绑定声明留宿主模板
 * (FORWARD_PLUS_PBR 模板 group3/binding13 storage;常量与 areaLights.ts 互钉)。
 */`,
    preamble: `export const DEEP_AREA_LIGHTING_WGSL = /* wgsl */ `,
  },
];

for (const entry of SHARED_WGSL) {
  const sourcePath = resolve(wgslRoot, entry.source);
  const wgsl = await readFile(sourcePath, "utf8");
  const bytes = Buffer.byteLength(wgsl, "utf8");
  const checksum = createHash("sha256").update(wgsl, "utf8").digest("hex");
  const moduleText = `// GENERATED FILE — DO NOT EDIT BY HAND(全文件生成物,手改会在字节门禁处被打回)。
// 唯一真源: wgsl/${entry.source}(WGSL 单源,TS 与 Rust 双端共享同一份文件)。
// 重新生成: pnpm --filter @bim-studio/deep-engine wgsl:sync
// 字节门禁: ${entry.gate}(?raw 读真源 + SHA-256 夹具对拍);
//          Rust 半: ${entry.rustHalf}(include_str! 引用同一文件,共用同一夹具)。

${entry.constants}
${entry.preamble}${JSON.stringify(wgsl)};
`;
  await writeFile(entry.module, moduleText, "utf8");
  await writeFile(`${sourcePath}.sha256`, `${checksum} ${bytes}\n`, "utf8");
  console.log(`synced wgsl/${entry.source} -> ${entry.module} (${bytes} bytes, sha256=${checksum})`);
}
