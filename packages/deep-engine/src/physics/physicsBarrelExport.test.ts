import { describe, expect, it } from "vitest";
import {
  createSdfCollisionProfile, createSdfQueryPointStream, fingerprintSdfQuerySamples,
  DEEP_SDF_COLLISION_QUERY_WGSL, SDF_COLLISION_PROFILE_DEFAULT_ENABLED, SDF_QUERY_LCG_SEED,
  type SdfCollisionProfile,
} from "./index.js";
import { loadFixtureGrid } from "./sdfCollisionTruthFixture.js";

/**
 * A2 barrel 接线合同(physics/index.ts → sdfCollisionProfile 家族):
 * 断言公开面经 barrel 可达且与直连模块同一实现 —— 用直连测试已钉定的
 * 跨端逐位指纹(native sdf_collision_profile_truth.rs 同字面量)作同源性证明,
 * 防止未来出现「barrel 指到第二套实现」的合同漂移。
 */

/** 与 sdfCollisionProfile.test.ts / native truth 测试互钉的跨端指纹。 */
const PINNED_CROSS_LANGUAGE_FINGERPRINT = "9d5c2f7210ed7244";

describe("physics barrel:A2 SDF collision profile 接线", () => {
  it("opt-in 默认关:字面量常量 false,运行时拒收非 true", () => {
    expect(SDF_COLLISION_PROFILE_DEFAULT_ENABLED).toBe(false);
    expect(() => createSdfCollisionProfile({
      enabled: false as unknown as true, grid: loadFixtureGrid(),
    })).toThrow(TypeError);
  });

  it("经 barrel 创建 profile,采样点流与指纹与直连模块逐位一致", () => {
    const grid = loadFixtureGrid();
    const profile: SdfCollisionProfile = createSdfCollisionProfile({ enabled: true, grid });
    const points = createSdfQueryPointStream(grid, 4096, SDF_QUERY_LCG_SEED);
    const samples = points.map(point => profile.sample(point));
    // 同一字面量 = barrel 暴露的是同一 f32 镜像实现(同源,非副本)。
    expect(fingerprintSdfQuerySamples(samples)).toBe(PINNED_CROSS_LANGUAGE_FINGERPRINT);
    // WGSL 单源常量经 barrel 可达(与 wgsl/sdfCollisionQuery.wgsl checksum 门同源)。
    expect(DEEP_SDF_COLLISION_QUERY_WGSL).toContain("fn queryCollisions");
  });
});
