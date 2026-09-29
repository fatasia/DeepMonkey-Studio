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
];

for (const entry of SHARED_WGSL) {
  const sourcePath = resolve(wgslRoot, entry.source);
  const wgsl = await readFile(sourcePath, "utf8");
  const bytes = Buffer.byteLength(wgsl, "utf8");
  const checksum = createHash("sha256").update(wgsl, "utf8").digest("hex");
  const moduleText = `// GENERATED FILE — DO NOT EDIT BY HAND(全文件生成物,手改会在字节门禁处被打回)。
// 唯一真源: wgsl/${entry.source}(WGSL 单源试点,TS 与 Rust 双端共享同一份文件)。
// 重新生成: pnpm --filter @bim-studio/deep-engine wgsl:sync
// 字节门禁: src/lighting/probeClipmapSamplingWgslChecksum.test.ts(?raw 读真源 + SHA-256 夹具对拍);
//          Rust 半: deep-engine-native/src/probe_gi_wgsl.rs(include_str! 引用同一文件,共用同一夹具)。

${entry.constants}
${entry.preamble}${JSON.stringify(wgsl)};
`;
  await writeFile(entry.module, moduleText, "utf8");
  await writeFile(`${sourcePath}.sha256`, `${checksum} ${bytes}\n`, "utf8");
  console.log(`synced wgsl/${entry.source} -> ${entry.module} (${bytes} bytes, sha256=${checksum})`);
}
