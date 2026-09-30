// I 级 C18 体积光 god rays WGSL 单源门禁(形态照抄 clusterLightCullingWgslChecksum.test.ts):
// 1) 生成镜像不陈旧;2) pinned SHA-256 夹具逐字节一致;3) GodRaysParams ABI 常量由
// WGSL 结构体文本**重新推导**对拍 —— 布局漂移(含 2026-09-30 修正的 10/160 → 9/144
// 计槽错误)在这里被拦下,而不是等消费端换装破裂;4) 绑定 0..3 各出现一次、入口与
// workgroup 契约、FAR 哨兵三方互钉。
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import pinnedChecksum from "../../wgsl/volumetricGodRays.wgsl.sha256?raw";
import sharedWgsl from "../../wgsl/volumetricGodRays.wgsl?raw";
import { DEEP_GOD_RAYS_ABI_VERSION, DEEP_GOD_RAYS_ENTRY, DEEP_GOD_RAYS_PARAMS_BYTES,
  DEEP_GOD_RAYS_PARAMS_VEC4_COUNT, DEEP_GOD_RAYS_SHADOW_FAR_SENTINEL, DEEP_GOD_RAYS_WORKGROUP_SIZE,
  VOLUMETRIC_GOD_RAYS_MARCH_WGSL } from "./volumetricGodRaysWgsl.js";
import { GOD_RAYS_SHADOW_FAR_SENTINEL } from "./volumetricGodRays.js";

const [checksum, byteLength] = pinnedChecksum.trim().split(/\s+/);

/** 按 WGSL 默认 storage 布局从结构体文本重推字节数(vec2 对齐 8,vec4 对齐 16,结构体对齐取成员最大值)。 */
function godRaysParamsByteSize(wgsl: string): number {
  const body = wgsl.match(/struct GodRaysParams \{([\s\S]*?)\n\};/)?.[1] ?? "";
  let offset = 0;
  let structAlign = 1;
  for (const rawLine of body.split("\n")) {
    const member = rawLine.replace(/\/\/.*$/, "").trim().replace(/,$/, "");
    if (!member) continue;
    const match = member.match(/:\s*vec(\d)<(u32|i32|f32)>$/);
    if (!match) throw new Error(`Unexpected GodRaysParams member in gate derivation: ${member}`);
    const components = Number(match[1]);
    const size = components * 4;
    const align = components === 4 ? 16 : components === 2 ? 8 : 4;
    offset = Math.ceil(offset / align) * align + size;
    structAlign = Math.max(structAlign, align);
  }
  if (!body) throw new Error("GodRaysParams struct not found in the shared WGSL source.");
  return Math.ceil(offset / structAlign) * structAlign;
}

describe("volumetric god rays WGSL single-source gate (TS half)", () => {
  it("generated mirror is byte-identical to the shared source file", () => {
    expect(VOLUMETRIC_GOD_RAYS_MARCH_WGSL).toBe(sharedWgsl);
  });

  it("matches the pinned checksum fixture", () => {
    const bytes = new TextEncoder().encode(VOLUMETRIC_GOD_RAYS_MARCH_WGSL);
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(checksum);
    expect(bytes.length).toBe(Number(byteLength));
  });

  it("derives GodRaysParams ABI constants from the struct text (vec4 槽位 9 / 144B)", () => {
    const derivedBytes = godRaysParamsByteSize(sharedWgsl);
    expect(derivedBytes).toBe(DEEP_GOD_RAYS_PARAMS_BYTES);
    expect(derivedBytes).toBe(DEEP_GOD_RAYS_PARAMS_VEC4_COUNT * 16);
    // 计槽口径:sourceSize/scatterSize 两个 vec2 合占 1 槽,另有 8 个 vec4 成员。
    const vec4Members = (sharedWgsl.match(/: vec4<(?:u32|i32|f32)>,/g) ?? []).length;
    expect(vec4Members).toBe(8);
    expect(DEEP_GOD_RAYS_PARAMS_VEC4_COUNT).toBe(vec4Members + 1);
    expect(DEEP_GOD_RAYS_ABI_VERSION).toBe(1);
  });

  it("locks the dispatch contract: entry point, workgroup size, and the four bindings exactly once", () => {
    expect(VOLUMETRIC_GOD_RAYS_MARCH_WGSL).toContain(`fn ${DEEP_GOD_RAYS_ENTRY}(`);
    expect(VOLUMETRIC_GOD_RAYS_MARCH_WGSL).toContain(`@compute @workgroup_size(${DEEP_GOD_RAYS_WORKGROUP_SIZE}, ${DEEP_GOD_RAYS_WORKGROUP_SIZE})`);
    expect(DEEP_GOD_RAYS_WORKGROUP_SIZE).toBe(8);
    const bindings = [...VOLUMETRIC_GOD_RAYS_MARCH_WGSL.matchAll(/@group\(0\) @binding\((\d+)\)/g)].map((m) => m[1]);
    expect(bindings).toEqual(["0", "1", "2", "3"]);
    expect(VOLUMETRIC_GOD_RAYS_MARCH_WGSL).toContain("@binding(0) var sourceDepth: texture_2d<f32>;");
    expect(VOLUMETRIC_GOD_RAYS_MARCH_WGSL).toContain("@binding(1) var shadowMap: texture_2d<f32>;");
    expect(VOLUMETRIC_GOD_RAYS_MARCH_WGSL).toContain("@binding(2) var<storage, read> godRaysParams: GodRaysParams;");
    expect(VOLUMETRIC_GOD_RAYS_MARCH_WGSL).toContain("@binding(3) var scatterTarget: texture_storage_2d<rgba16float, write>;");
  });

  it("keeps the FAR sentinel and the shadow comparison semantics pinned across the family", () => {
    expect(DEEP_GOD_RAYS_SHADOW_FAR_SENTINEL).toBe(GOD_RAYS_SHADOW_FAR_SENTINEL);
    expect(DEEP_GOD_RAYS_SHADOW_FAR_SENTINEL).toBe(1e9);
    // 域外 fail-open → 最近邻 floor+clamp → 严格 >= 深度比较(WGSL 半;CPU 镜像锁在同族测试)。
    expect(VOLUMETRIC_GOD_RAYS_MARCH_WGSL).toContain("if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return 1.0; }");
    expect(VOLUMETRIC_GOD_RAYS_MARCH_WGSL).toContain("return select(0.0, 1.0, stored >= basisW - godRaysParams.shadowBasisForward.w);");
    // strength 乘在 radiance 侧(与 CPU 镜像同序)。
    expect(VOLUMETRIC_GOD_RAYS_MARCH_WGSL).toContain("inscatter += (godRaysParams.lightRadiance.xyz * godRaysParams.lightRadiance.w) * (scattering * transmittance);");
  });
});
