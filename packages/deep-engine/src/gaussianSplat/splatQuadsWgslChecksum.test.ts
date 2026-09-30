// I 级 C1 3DGS 家族的 TS 半字节门禁(形态照抄 materialDielectricWgslChecksum.test.ts):
// 1) 生成镜像不陈旧:导出串与真源 wgsl/gaussianSplatQuads.wgsl 逐字节一致;
// 2) 跨宿主对拍:镜像字节 SHA-256 与共享夹具 .sha256(<hex> <byteLen>)一致;
// 3) 结构合同:入口名/绑定槽/record 步长字面量在场(纯 TS 消费,无 Rust 半)。
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import pinnedChecksum from "../../wgsl/gaussianSplatQuads.wgsl.sha256?raw";
import sharedWgsl from "../../wgsl/gaussianSplatQuads.wgsl?raw";
import {
  DEEP_GAUSSIAN_SPLAT_ABI_VERSION,
  DEEP_GAUSSIAN_SPLAT_RECORD_BYTES,
  DEEP_GAUSSIAN_SPLAT_UNIFORM_BYTES,
  GAUSSIAN_SPLAT_QUADS_WGSL,
} from "./splatQuadsWgsl.js";
import { SPLAT_RECORD_BYTE_STRIDE } from "./splatFormatContract.js";
import { SPLAT_UNIFORM_BYTE_LENGTH } from "./splatGpuResources.js";

const [checksum, byteLength] = pinnedChecksum.trim().split(/\s+/);

describe("gaussianSplatQuads WGSL single-source gate (TS half)", () => {
  it("generated mirror is byte-identical to the shared source file", () => {
    expect(GAUSSIAN_SPLAT_QUADS_WGSL).toBe(sharedWgsl);
  });

  it("matches the pinned cross-host checksum fixture", () => {
    const bytes = new TextEncoder().encode(GAUSSIAN_SPLAT_QUADS_WGSL);
    expect(checksum).toMatch(/^[0-9a-f]{64}$/u);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(checksum);
    expect(bytes.length).toBe(Number(byteLength));
  });

  it("pins the ABI constants and the record/uniform byte budget on both halves", () => {
    expect(DEEP_GAUSSIAN_SPLAT_ABI_VERSION).toBe(1);
    expect(DEEP_GAUSSIAN_SPLAT_RECORD_BYTES).toBe(64);
    expect(DEEP_GAUSSIAN_SPLAT_UNIFORM_BYTES).toBe(176);
    expect(SPLAT_RECORD_BYTE_STRIDE).toBe(DEEP_GAUSSIAN_SPLAT_RECORD_BYTES);
    expect(SPLAT_UNIFORM_BYTE_LENGTH).toBe(DEEP_GAUSSIAN_SPLAT_UNIFORM_BYTES);
  });

  it("keeps the structural contract: entries, bindings and the storage element type", () => {
    expect(GAUSSIAN_SPLAT_QUADS_WGSL).toContain("fn vsMain(");
    expect(GAUSSIAN_SPLAT_QUADS_WGSL).toContain("fn fsMain(");
    expect(GAUSSIAN_SPLAT_QUADS_WGSL).toContain("@group(0) @binding(0) var<uniform> frame : SplatFrameParams;");
    expect(GAUSSIAN_SPLAT_QUADS_WGSL).toContain("var<storage, read> splats : array<vec4f>;");
    // 平衡括号廉价防呆(语法权威校验留 naga/Dawn,见交付报告 unmeasured 留项)。
    const open = (GAUSSIAN_SPLAT_QUADS_WGSL.match(/\{/gu) ?? []).length;
    const close = (GAUSSIAN_SPLAT_QUADS_WGSL.match(/\}/gu) ?? []).length;
    expect(open).toBe(close);
    expect(open).toBeGreaterThan(0);
  });
});
