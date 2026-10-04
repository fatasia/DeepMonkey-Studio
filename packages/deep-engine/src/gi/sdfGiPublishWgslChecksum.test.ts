// Brief-GI M3 探针消费物化 WGSL 单源 TS 半字节门禁(形态照抄 sdfGiProbeUpdateWgslChecksum.test.ts):
// 1) 生成镜像不陈旧;2) 共享夹具(?raw sidecar)SHA-256/字节长对拍;
// 3) texel 布局/确定性/F5 恒零合同字面锁定;4) Naga 语义校验(env 门控)。
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import pinnedChecksum from "../../wgsl/sdfGiPublish.wgsl.sha256?raw";
import sharedWgsl from "../../wgsl/sdfGiPublish.wgsl?raw";
import { DEEP_SDF_GI_PUBLISH_WGSL, SDF_GI_PUBLISH_ENTRY, SDF_GI_PUBLISH_PARAMS_BYTES,
  SDF_GI_PUBLISH_RECORD_VEC4_STRIDE, SDF_GI_PUBLISH_WORKGROUP_SIZE } from "./sdfGiPublishWgsl.js";
import { SDF_GI_PROBE_RECORD_VEC4_STRIDE } from "./sdfGiProbeUpdateWgsl.js";
import { DEEP_GI_TEXTURE_MOMENTS_BINDING, DEEP_GI_TEXTURE_SAMPLER_BINDING,
  DEEP_GI_TEXTURE_LEVELS_BINDING, DEEP_GI_TEXTURE_BINDING } from "../lighting/probeClipmapTextureSamplingWgsl.js";

const [checksum, byteLength] = pinnedChecksum.trim().split(/\s+/);
const NAGA = process.env.DEEP_SHADER_NAGA_BIN;

describe("SDF GI publish WGSL single-source cross-host gate (TS half)", () => {
  it("generated mirror is byte-identical to the shared source file", () => {
    expect(DEEP_SDF_GI_PUBLISH_WGSL).toBe(sharedWgsl);
  });

  it("matches the pinned cross-host checksum fixture", () => {
    const bytes = new TextEncoder().encode(DEEP_SDF_GI_PUBLISH_WGSL);
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(checksum);
    expect(bytes.length).toBe(Number(byteLength));
  });

  it("keeps the texel-layout + determinism + F5-absent literals locked", () => {
    // 每 lane 独立物化一个探针格 cell:无 workgroup 共享内存、无原子 —— 同输入逐位回放。
    expect(DEEP_SDF_GI_PUBLISH_WGSL).not.toContain("atomic");
    expect(DEEP_SDF_GI_PUBLISH_WGSL).not.toContain("var<workgroup>");
    expect(DEEP_SDF_GI_PUBLISH_WGSL)
      .toContain(`@compute @workgroup_size(${SDF_GI_PUBLISH_WORKGROUP_SIZE})`);
    expect(DEEP_SDF_GI_PUBLISH_WGSL).toContain(`fn ${SDF_GI_PUBLISH_ENTRY}(`);
    // texel 布局合同:volume = record vec4[0] 透传;moments lane0 = vec4[1].xyz + valid=1。
    expect(DEEP_SDF_GI_PUBLISH_WGSL).toContain(
      "textureStore(deepGiVolume, vec2i(cell.xy), i32(cell.z), irradianceValidity)");
    expect(DEEP_SDF_GI_PUBLISH_WGSL).toContain(
      "vec4f(visibility.xyz, 1.0)");
    // F5 合同:words[12..23](vec4[3..5])在本核同样绝不合成 —— moments lane1..3 恒零
    // (SH 缺失,specular 门走标量 fallback)。
    expect(DEEP_SDF_GI_PUBLISH_WGSL).toContain("let zero = vec4f(0.0);");
    expect(DEEP_SDF_GI_PUBLISH_WGSL).not.toContain("records[base + 2u]");
    expect(DEEP_SDF_GI_PUBLISH_WGSL).not.toContain("records[base + 3u]");
    // 采样端 binding 槽位与 group3 纹理 ABI 互钉(publish 的纹理即主 pass 消费的纹理)。
    expect(DEEP_GI_TEXTURE_BINDING).toBe(9);
    expect(DEEP_GI_TEXTURE_SAMPLER_BINDING).toBe(10);
    expect(DEEP_GI_TEXTURE_LEVELS_BINDING).toBe(11);
    expect(DEEP_GI_TEXTURE_MOMENTS_BINDING).toBe(16);
    expect(SDF_GI_PUBLISH_WORKGROUP_SIZE).toBe(64);
    expect(SDF_GI_PUBLISH_PARAMS_BYTES).toBe(32); // vec3u@0(对齐16)+3×u32 → struct 尺寸 32B
    expect(SDF_GI_PUBLISH_ENTRY).toBe("sdfGiPublishMain");
    // 记录 ABI 步长与探针更新核互钉(同一 96B 记录场的读写两端)。
    expect(SDF_GI_PUBLISH_RECORD_VEC4_STRIDE).toBe(6);
    expect(SDF_GI_PROBE_RECORD_VEC4_STRIDE).toBe(6);
  });

  it.runIf(Boolean(NAGA))("passes Naga WGSL parsing and semantic validation", () => {
    const result = spawnSync(NAGA!,
      ["--stdin-file-path", "sdfGiPublish.wgsl", "--input-kind", "wgsl"], {
      input: sharedWgsl, encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Validation successful");
  });
});
