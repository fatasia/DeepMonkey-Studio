import { describe, expect, it } from "vitest";
import { CLUSTER_LOD_DEFAULT_PIXEL_THRESHOLD, CLUSTER_LOD_MIN_VIEW_DEPTH, CLUSTER_LOD_REFINE_SENTINEL,
  CLUSTER_LOD_SELECTION_WORKGROUP_SIZE } from "./clusterLodSelection.js";
import { emitClusterLodSelectionWgsl, CLUSTER_LOD_SELECTION_BINDINGS, CLUSTER_LOD_SELECTION_ENTRY_POINT } from "./clusterLodSelectionKernel.js";

/** kernel 生成合同：布局常量单一来源插值 + 与 CPU 参考逐式对应 + fail-closed 哨兵结构。 */
describe("cluster lod selection kernel generation contract", () => {
  const wgsl = emitClusterLodSelectionWgsl();

  it("is deterministic across emissions", () => {
    expect(emitClusterLodSelectionWgsl()).toBe(wgsl);
  });

  it("interpolates layout constants from the single source of truth", () => {
    expect(wgsl).toContain(`const REFINE_SENTINEL: u32 = ${CLUSTER_LOD_REFINE_SENTINEL}u;`);
    expect(wgsl).toContain(`const MIN_VIEW_DEPTH: f32 = ${CLUSTER_LOD_MIN_VIEW_DEPTH};`);
    expect(wgsl).toContain(`const DEFAULT_PIXEL_THRESHOLD: f32 = ${CLUSTER_LOD_DEFAULT_PIXEL_THRESHOLD}.0;`);
    expect(wgsl).toContain(`@workgroup_size(${CLUSTER_LOD_SELECTION_WORKGROUP_SIZE})`);
    expect(wgsl).toContain(`fn ${CLUSTER_LOD_SELECTION_ENTRY_POINT}(`);
    expect(wgsl).toContain("@compute");
  });

  it("declares the ClusterLodNode struct in the contracted byte order", () => {
    const struct = wgsl.slice(wgsl.indexOf("struct ClusterLodNode"), wgsl.indexOf("struct Params"));
    const fields = ["boundsMin: vec4f", "boundsMax: vec4f", "errorScalar: f32", "lodLevel: u32",
      "clusterIndex: u32", "firstTriangle: u32", "triangleCount: u32", "pad0: u32", "pad1: u32", "pad2: u32"];
    let cursor = 0;
    for (const field of fields) {
      const at = struct.indexOf(field, cursor);
      expect(at).toBeGreaterThanOrEqual(0);
      cursor = at + field.length;
    }
  });

  it("keeps the uniform struct pure vec4f for the 16-byte alignment contract", () => {
    const struct = wgsl.slice(wgsl.indexOf("struct Params"), wgsl.indexOf("@group(0)"));
    expect(struct).toContain("camPositionTanHalf: vec4f");
    expect(struct).toContain("forwardThreshold: vec4f");
    expect(struct).toContain("viewportNodeCount: vec4f");
    expect(struct.match(/: (?!vec4f)\w+[,:]/gu)).toBeNull();
  });

  it("binds all four storage/uniform slots in executor order", () => {
    CLUSTER_LOD_SELECTION_BINDINGS.forEach((entry, index) => {
      expect(entry.binding).toBe(index);
      const pattern = `@binding(${index}) var<${entry.type === "uniform" ? "uniform" : entry.type === "storage" ? "storage, read_write" : "storage, read"}>`;
      expect(wgsl).toContain(pattern);
      expect(wgsl).toContain(`${entry.name}:`);
    });
  });

  it("mirrors the CPU reference selection formula term by term", () => {
    // 与 clusterLodSelection.clusterScreenError 的表达式逐项对应（深度钳制 + 误差投影）。
    expect(wgsl).toContain("let center = (node.boundsMin.xyz + node.boundsMax.xyz) * 0.5;");
    expect(wgsl).toContain(
      "let depth = max(dot(center - params.camPositionTanHalf.xyz, params.forwardThreshold.xyz), MIN_VIEW_DEPTH);");
    expect(wgsl).toContain(
      "let screenError = node.errorScalar * params.viewportNodeCount.x / (2.0 * depth * params.camPositionTanHalf.w);");
    // 选中判定与 CPU 同用 ≤（阈值边界两侧语义一致），空 cluster 恒不选中。
    expect(wgsl).toContain("if (node.triangleCount > 0u && screenError <= params.forwardThreshold.w) {");
    expect(wgsl).toContain("chosen = node.lodLevel;");
  });

  it("fails closed on non-finite screen error instead of silently emitting a level", () => {
    expect(wgsl).toContain("atomicAdd(&selectionFaults, 1u);");
    expect(wgsl).toContain("chosen = REFINE_SENTINEL;");
    expect(wgsl.indexOf("if (!(screenError >= 0.0)) {"))
      .toBeLessThan(wgsl.indexOf("selection[nodeIndex] = chosen;"));
  });

  it("guards out-of-range lanes before any buffer access", () => {
    const body = wgsl.slice(wgsl.indexOf(`fn ${CLUSTER_LOD_SELECTION_ENTRY_POINT}`));
    const guard = body.indexOf("if (nodeIndex >= u32(params.viewportNodeCount.y)) { return; }");
    const firstAccess = body.indexOf("clusterNodes[");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(firstAccess);
  });

  it("writes exactly one selection slot per node", () => {
    expect(wgsl.match(/selection\[nodeIndex\]/gu)?.length).toBe(1);
  });
});
