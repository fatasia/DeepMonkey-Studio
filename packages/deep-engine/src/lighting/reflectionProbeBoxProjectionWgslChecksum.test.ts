// WGSL 单源 C15 家族 TS 半字节门禁(与 probeClipmapSamplingWgslChecksum.test.ts 同纪律):
// 1) 生成镜像不陈旧:导出串与真源 wgsl/reflectionProbeBoxProjection.wgsl 逐字节一致;
// 2) 跨宿主对拍:SHA-256 与共享夹具 .sha256(<hex> <byteLen>)一致(本家族无 Rust 半,
//    夹具由 sync 脚本生成,是"真源未被手改"的锚);
// 3) ABI 常量与真源插值点字面一致:哨兵/阈值/判据任何一端单独漂移都会在此失败。
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import pinnedChecksum from "../../wgsl/reflectionProbeBoxProjection.wgsl.sha256?raw";
import sharedWgsl from "../../wgsl/reflectionProbeBoxProjection.wgsl?raw";
import { DEEP_REFLECTION_PROBE_ABI_VERSION, DEEP_REFLECTION_PROBE_BOX_BYTES,
  DEEP_REFLECTION_PROBE_DIRECTION_EPSILON, DEEP_REFLECTION_PROBE_RECORD_BYTES,
  DEEP_REFLECTION_PROBE_SECONDARY_CUTOFF, DEEP_REFLECTION_PROBE_SENTINEL_DEGENERATE,
  DEEP_REFLECTION_PROBE_SENTINEL_OUTSIDE, DEEP_REFLECTION_PROBE_UNCONSTRAINED_STEP,
  DEEP_REFLECTION_PROBE_BOX_PROJECTION_WGSL } from "./reflectionProbeBoxProjectionWgsl.js";

const [checksum, byteLength] = pinnedChecksum.trim().split(/\s+/);

describe("WGSL single-source cross-host gate (C15 reflection probe box projection)", () => {
  it("generated mirror is byte-identical to the shared source file", () => {
    expect(DEEP_REFLECTION_PROBE_BOX_PROJECTION_WGSL).toBe(sharedWgsl);
  });

  it("matches the pinned cross-host checksum fixture", () => {
    const bytes = new TextEncoder().encode(DEEP_REFLECTION_PROBE_BOX_PROJECTION_WGSL);
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(checksum);
    expect(bytes.length).toBe(Number(byteLength));
  });

  it("stays a pure function library: no binding declarations leak into the core", () => {
    // 纯函数库合同:资源绑定由宿主模板提供(group0/binding3 specularEnvironment 等)。
    // 本核若私自带 @group/@binding 会与宿主绑定布局冲突,必须在此拦截。
    expect(DEEP_REFLECTION_PROBE_BOX_PROJECTION_WGSL).not.toContain("@group");
    expect(DEEP_REFLECTION_PROBE_BOX_PROJECTION_WGSL).not.toContain("@binding");
    expect(DEEP_REFLECTION_PROBE_BOX_PROJECTION_WGSL).toContain("struct DeepReflectionProbeBox");
    expect(DEEP_REFLECTION_PROBE_BOX_PROJECTION_WGSL).toContain("fn deepReflectionProbeBoxProject");
    expect(DEEP_REFLECTION_PROBE_BOX_PROJECTION_WGSL).toContain("fn deepReflectionProbeInfluenceWeight");
    expect(DEEP_REFLECTION_PROBE_BOX_PROJECTION_WGSL).toContain("fn deepReflectionProbePairWeights");
  });

  it("keeps the exported ABI constants in lockstep with the pinned WGSL literals", () => {
    // 不校正哨兵:盒外 = -1、退化输入 = -2(返回 w 槽;宿主按负值回退原始反射向量)。
    expect(DEEP_REFLECTION_PROBE_BOX_PROJECTION_WGSL)
      .toContain(`vec4f(reflectionDirection, ${DEEP_REFLECTION_PROBE_SENTINEL_OUTSIDE}.0)`);
    expect(DEEP_REFLECTION_PROBE_BOX_PROJECTION_WGSL)
      .toContain(`vec4f(reflectionDirection, ${DEEP_REFLECTION_PROBE_SENTINEL_DEGENERATE}.0)`);
    // 方向零判据出现 2 次(模长守卫 + 逐轴约束判据);有限守卫 limit 字面 8 处
    // (7 处 finite3 + 1 处不约束轴哨兵),任何一处单独漂移都算语义漂移。
    expect(DEEP_REFLECTION_PROBE_BOX_PROJECTION_WGSL.split(`0.000001`).length - 1).toBe(3);
    expect(DEEP_REFLECTION_PROBE_BOX_PROJECTION_WGSL.split(`1000000000.0`).length - 1).toBe(8);
    expect(DEEP_REFLECTION_PROBE_UNCONSTRAINED_STEP).toBe(1_000_000_000);
    expect(DEEP_REFLECTION_PROBE_DIRECTION_EPSILON).toBe(0.000001);
    // 布局与混合阈值:CPU 数据面(packReflectionProbeRecord/selectReflectionProbePair)按此互钉。
    expect(DEEP_REFLECTION_PROBE_ABI_VERSION).toBe(1);
    expect(DEEP_REFLECTION_PROBE_RECORD_BYTES).toBe(64);
    expect(DEEP_REFLECTION_PROBE_BOX_BYTES).toBe(32);
    expect(DEEP_REFLECTION_PROBE_SECONDARY_CUTOFF).toBe(0.01);
  });
});
