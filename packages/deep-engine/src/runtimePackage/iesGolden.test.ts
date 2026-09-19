import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseIesProfile, summarizeIesProfile } from "../lighting/iesProfile.js";
import { intensityFactor, prepareIesSampling } from "../lighting/iesSampling.js";
import { runtimeContentSha256 } from "./hash.js";
import { quantizeIesLightProfile } from "./lightProfiles.js";
import { sha256Utf8 } from "../shaderPackage/hash.js";

/** 生产者侧 golden 自检：对冻结的 e02-golden.json 逐源重算，任何漂移都会在此失败。
 * 消费者侧互钉在 deep-engine-native/src/runtime_package/light_profiles.rs（include_str! 同一 JSON）。 */
const golden = JSON.parse(readFileSync(new URL("../../fixtures/ies/e02-golden.json", import.meta.url), "utf8")) as {
  schema: string; schemaVersion: number; domain: string;
  samplePlan: { thetaDeg: number[]; phiDeg: number[]; rotationDeg: number[]; scaleFactor: number[] };
  profiles: { profileId: string; source: string; profile: unknown; contentHash: string;
    summary: { maxCandela: number; totalLuminousFluxLumens: number; beamAngleDegrees: number | null } }[];
  expectedFactorBits: Record<string, string>;
  negativeSources: { file: string; errorContains: string }[];
};

const fixed = (value: number): string => value.toFixed(6);
function f64Bits(value: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value === 0 ? 0 : value, false);
  let hex = "";
  for (let index = 0; index < 8; index += 1) hex += view.getUint8(index).toString(16).padStart(2, "0");
  return hex;
}

describe("E02 IES golden cross-end contract (producer side)", () => {
  it("freezes the schema, domain and deterministic sample plan", () => {
    expect(golden.schema).toBe("deep-engine.ies-golden");
    expect(golden.schemaVersion).toBe(1);
    expect(golden.domain).toBe("deep-engine.ies-golden.v1\n");
    expect(golden.profiles.length).toBeGreaterThanOrEqual(4);
  });

  for (const entry of golden.profiles) {
    it(`re-derives ${entry.profileId} from ${entry.source} byte-identically`, () => {
      const parsed = parseIesProfile(readFileSync(new URL(`../../fixtures/ies/${entry.source}`, import.meta.url), "utf8"));
      const table = quantizeIesLightProfile(entry.profileId, parsed);
      expect(table).toEqual(entry.profile);
      expect(runtimeContentSha256(table)).toBe(entry.contentHash);
      // 摘要与解析器输出一致（解析验收格：流明/峰值/光束角）。
      expect(summarizeIesProfile(parsed).totalLuminousFluxLumens).toBeCloseTo(entry.summary.totalLuminousFluxLumens, 1);
      expect(summarizeIesProfile(parsed).maxCandela).toBe(entry.summary.maxCandela);
      // 采样计划按行序重算，位模式序列哈希必须与 golden 一致（Rust 侧同法互钉）。
      const sampling = prepareIesSampling(table);
      let series = "";
      for (const theta of golden.samplePlan.thetaDeg) {
        for (const phi of golden.samplePlan.phiDeg) {
          for (const rotation of golden.samplePlan.rotationDeg) {
            for (const scale of golden.samplePlan.scaleFactor) {
              series += `${entry.profileId}|${fixed(theta)}|${fixed(phi)}|${fixed(rotation)}|${fixed(scale)}|${f64Bits(intensityFactor(sampling, theta, phi, rotation, scale))}\n`;
            }
          }
        }
      }
      expect(sha256Utf8(golden.domain + series)).toBe(golden.expectedFactorBits[entry.profileId]);
    });
  }

  it("rejects the real-world asymmetric sweep sources by contract name", () => {
    for (const negative of golden.negativeSources) {
      const parsed = parseIesProfile(readFileSync(new URL(`../../fixtures/ies/${negative.file}`, import.meta.url), "utf8"));
      expect(() => quantizeIesLightProfile(`negative.${negative.file}`, parsed)).toThrowError(new RegExp(negative.errorContains.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });
});
