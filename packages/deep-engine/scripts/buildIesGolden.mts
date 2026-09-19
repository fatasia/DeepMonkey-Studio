// E02 IES golden 生成器：从冻结的 .ies 源（fixtures/ies/*.ies）重算量化表、
// canonical 内容哈希与采样位模式哈希，写入 fixtures/ies/e02-golden.json。
// Rust 侧（deep-engine-native/src/runtime_package/light_profiles.rs）以同一 JSON
// 做消费者互钉。重新生成后必须保持双端测试同时通过。
// 运行：pnpm --dir packages/deep-engine exec tsx scripts/buildIesGolden.mts
import { readFileSync, writeFileSync } from "node:fs";
import { parseIesProfile, summarizeIesProfile } from "../src/lighting/iesProfile.js";
import { intensityFactor, prepareIesSampling } from "../src/lighting/iesSampling.js";
import { quantizeIesLightProfile } from "../src/runtimePackage/lightProfiles.js";
import { runtimeContentSha256 } from "../src/runtimePackage/hash.js";
import { sha256Utf8 } from "../src/shaderPackage/hash.js";

export const GOLDEN_DOMAIN = "deep-engine.ies-golden.v1\n";
const SOURCES = [
  { file: "e02-cone-hemisphere.ies", profileId: "syn.cone-hemisphere" },
  { file: "e02-quad-0-90.ies", profileId: "syn.quad-0-90" },
  { file: "007cfb11e343e2f42e3b476be4ab684e.ies", profileId: "real.bega-50975-6k3" },
  { file: "1a936937a49c63374e6d4fbed9252b29.ies", profileId: "real.els-dt106-xtm10" },
] as const;
/** 采样计划全部取二进制精确的十进制值（半度网格邻域+对称镜像邻域），双端格式化无舍入歧义。 */
const PLAN = {
  thetaDeg: [0, 0.25, 12.5, 45, 89.75, 90, 90.25, 135, 179.5, 180],
  phiDeg: [0, 45, 90, 135, 179.5, 180, 224.5, 270, 315.5, 359.75],
  rotationDeg: [0, 45],
  scaleFactor: [1, 0.5],
} as const;
const NEGATIVE_SOURCES = [
  { file: "02a7562c650498ebb301153dbbf59207.ies", errorContains: "0–90/0–180" },
  { file: "06b4cfdc8805709e767b5e2e904be8ad.ies", errorContains: "0–90/0–180" },
] as const;

const fixed = (value: number): string => value.toFixed(6);
function f64Bits(value: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value === 0 ? 0 : value, false);
  let hex = "";
  for (let index = 0; index < 8; index += 1) hex += view.getUint8(index).toString(16).padStart(2, "0");
  return hex;
}

const profiles: unknown[] = [];
const expectedFactorBits: Record<string, string> = {};
for (const source of SOURCES) {
  const table = quantizeIesLightProfile(source.profileId, parseIesProfile(readFileSync(new URL(`../fixtures/ies/${source.file}`, import.meta.url), "utf8")));
  const summary = summarizeIesProfile(parseIesProfile(readFileSync(new URL(`../fixtures/ies/${source.file}`, import.meta.url), "utf8")));
  const sampling = prepareIesSampling(table);
  let series = "";
  for (const theta of PLAN.thetaDeg) {
    for (const phi of PLAN.phiDeg) {
      for (const rotation of PLAN.rotationDeg) {
        for (const scale of PLAN.scaleFactor) {
          const bits = f64Bits(intensityFactor(sampling, theta, phi, rotation, scale));
          series += `${source.profileId}|${fixed(theta)}|${fixed(phi)}|${fixed(rotation)}|${fixed(scale)}|${bits}\n`;
        }
      }
    }
  }
  expectedFactorBits[source.profileId] = sha256Utf8(GOLDEN_DOMAIN + series);
  profiles.push({ profileId: source.profileId, source: source.file, profile: table, contentHash: runtimeContentSha256(table), summary });
}
const golden = {
  schema: "deep-engine.ies-golden", schemaVersion: 1,
  domain: GOLDEN_DOMAIN,
  note: "TS 生产者 / Rust 消费者互钉：profile.contentHash 用 runtime canonical sha256；expectedFactorBits 为采样计划按行序 'id|theta|phi|rot|scale|bits' 的 sha256（域前缀隔离）。",
  samplePlan: PLAN,
  profiles,
  expectedFactorBits,
  negativeSources: NEGATIVE_SOURCES,
};
const target = new URL("../fixtures/ies/e02-golden.json", import.meta.url);
writeFileSync(target, `${JSON.stringify(golden, null, 1)}\n`);
console.log(`wrote ${target.pathname} with ${profiles.length} profiles`);
for (const [id, hash] of Object.entries(expectedFactorBits)) console.log(`${id}: ${hash}`);
