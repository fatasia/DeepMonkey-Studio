// I 级 C2 集群光源剔除 WGSL 单源门禁(形态照抄 iesSamplingWgslChecksum.test.ts):
// 1) 生成镜像不陈旧;2) pinned SHA-256 夹具逐字节一致;3) ABI 结构体与 clusterAbiWgsl.ts
// (v2,80B)逐字一致——漂移即 group-3 消费端换装破裂;4) 三 entry point 与原子合同锁定,
// 且不携带 @group 声明冲突(本家族自带绑定,与 FORWARD_PLUS_PBR_WGSL 组合互斥,不嵌入宿主)。
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import pinnedChecksum from "../../wgsl/clusterLightCulling.wgsl.sha256?raw";
import sharedWgsl from "../../wgsl/clusterLightCulling.wgsl?raw";
import { FORWARD_PLUS_CLUSTER_ABI_WGSL, FORWARD_PLUS_CLUSTER_PARAMETER_BYTES } from "./clusterAbiWgsl.js";
import { CLUSTER_LIGHT_CULLING_PARAMETER_BYTES, CLUSTER_LIGHT_CULLING_WGSL, CLUSTER_LIGHT_CULLING_WORKGROUP_SIZE } from "./clusterLightCullingWgsl.js";

const [checksum, byteLength] = pinnedChecksum.trim().split(/\s+/);

describe("cluster light culling WGSL single-source gate (TS half)", () => {
  it("generated mirror is byte-identical to the shared source file", () => {
    expect(CLUSTER_LIGHT_CULLING_WGSL).toBe(sharedWgsl);
  });

  it("matches the pinned checksum fixture", () => {
    const bytes = new TextEncoder().encode(CLUSTER_LIGHT_CULLING_WGSL);
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(checksum);
    expect(bytes.length).toBe(Number(byteLength));
  });

  it("keeps the cluster ABI structs verbatim against clusterAbiWgsl (v2, 80B)", () => {
    expect(CLUSTER_LIGHT_CULLING_PARAMETER_BYTES).toBe(FORWARD_PLUS_CLUSTER_PARAMETER_BYTES);
    for (const structLine of FORWARD_PLUS_CLUSTER_ABI_WGSL.split("\n").filter(line => line.includes("struct ") || line.trim().startsWith("grid0") || line.trim().startsWith("offset"))) {
      expect(CLUSTER_LIGHT_CULLING_WGSL).toContain(structLine.trim());
    }
    expect(CLUSTER_LIGHT_CULLING_WGSL).toContain("struct ClusterParamsAbi {");
    expect(CLUSTER_LIGHT_CULLING_WGSL).toContain("struct ClusterHeaderAbi { offset: u32, count: u32 };");
  });

  it("locks the three-phase dispatch contract and atomic budget semantics", () => {
    expect(CLUSTER_LIGHT_CULLING_WGSL).toContain("@compute @workgroup_size(" + CLUSTER_LIGHT_CULLING_WORKGROUP_SIZE + ")");
    expect(CLUSTER_LIGHT_CULLING_WGSL).toContain("fn resetLists(");
    expect(CLUSTER_LIGHT_CULLING_WGSL).toContain("fn cullLights(");
    expect(CLUSTER_LIGHT_CULLING_WGSL).toContain("fn finalizeCounts(");
    // headers 以扁平 atomic<u32> 视图声明(atomic<u32> 内存表示同 u32,[offset,count] 布局不变)。
    expect(CLUSTER_LIGHT_CULLING_WGSL).toContain("var<storage, read_write> headers: array<atomic<u32>>");
    expect(CLUSTER_LIGHT_CULLING_WGSL).toContain("atomicStore(&headers[cluster * 2u], cluster * maxPerCluster)");
    expect(CLUSTER_LIGHT_CULLING_WGSL).toContain("let rank = atomicAdd(&headers[cluster * 2u + 1u], 1u)");
    expect(CLUSTER_LIGHT_CULLING_WGSL).toContain("atomicAdd(&overflowCount, 1u)");
    expect(CLUSTER_LIGHT_CULLING_WGSL).toContain("lightIndices[cluster * maxPerCluster + rank] = light");
    expect(CLUSTER_LIGHT_CULLING_WGSL).toContain("atomicStore(&headers[cluster * 2u + 1u], min(count, maxPerCluster))");
    expect(CLUSTER_LIGHT_CULLING_WGSL).toContain("0xffffffffu");
    // 垂直符号约定与 B1 同源:片元左上原号,+Y 投影朝 tile 0。
    expect(CLUSTER_LIGHT_CULLING_WGSL).toContain("tileAt(max(-1.0, -maxY), viewportHeight, tileSizeY, tilesY)");
  });
});
