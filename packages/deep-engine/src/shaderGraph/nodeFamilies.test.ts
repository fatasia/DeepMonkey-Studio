import { describe, expect, it } from "vitest";
import { compileShaderPass } from "../shader/compiler.js";
import type { DeepShaderAsset, ShaderNode, ShaderValueType } from "../shader/types.js";
import type { ShaderGraphAssetV1, ShaderGraphNodeInstance } from "./graphTypes.js";
import { lowerShaderGraphAsset } from "./lowering.js";
import { shaderGraphNodeInputCount, shaderGraphNodeMetadata, shaderGraphNodeRegistry } from "./nodeRegistry.js";

/** P2 节点族扩充:15 个新 op(NME 常用集)逐个 lowering→WGSL 正确性可测。 */
const NEW_OPS = [
  "min", "max", "pow", "clamp", "select", "mix", "smoothstep", "one-minus", "abs", "floor",
  "fract", "cross", "scale", "transform-direction", "transform-position",
] as const;

function node(id: string, op: string, type: ShaderValueType, config?: Record<string, unknown>): ShaderGraphNodeInstance {
  return { id, op: op as never, type, ...(config ? { config } : {}) };
}

/** 一张把 15 个新 op 全部连到 position 输出的编辑器图(depth pass 的 vertex stage)。 */
function familyGraph(): ShaderGraphAssetV1 {
  const nodes = [
    node("x", "literal", "f32", { value: 0.6 }), node("y", "literal", "f32", { value: 0.25 }),
    node("lo", "literal", "f32", { value: 0.1 }), node("hi", "literal", "f32", { value: 0.9 }),
    node("hs", "literal", "f32", { value: 0.5 }), node("bt", "literal", "bool", { value: true }),
    node("n1", "property", "vec3f", { name: "normalTs" }), node("n2", "property", "vec3f", { name: "tangentTs" }),
    node("m3", "property", "mat3x3f", { name: "normalMatrix" }), node("m4", "property", "mat4x4f", { name: "objectToClip" }),
    node("mn", "min", "f32"), node("mx", "max", "f32"), node("pw", "pow", "f32"),
    node("cl", "clamp", "f32"), node("sel", "select", "f32"), node("ss", "smoothstep", "f32"),
    node("om", "one-minus", "f32"), node("sub", "subtract", "f32"), node("ab", "abs", "f32"),
    node("fl", "floor", "f32"), node("fr", "fract", "f32"),
    node("cr", "cross", "vec3f"), node("sc", "scale", "vec3f"), node("td", "transform-direction", "vec3f"),
    node("mxv", "mix", "vec3f"), node("clv", "clamp", "vec3f"), node("dt", "dot", "f32"),
    node("s1", "add", "f32"), node("s2", "add", "f32"), node("s3", "add", "f32"), node("s4", "add", "f32"),
    node("s5", "add", "f32"), node("s6", "add", "f32"), node("s7", "add", "f32"), node("s8", "add", "f32"),
    node("s9", "add", "f32"), node("s10", "add", "f32"),
    node("v1", "add", "vec3f"), node("v2", "add", "vec3f"), node("v3", "add", "vec3f"), node("v4", "add", "vec3f"),
    node("pv", "transform-position", "vec4f"),
  ];
  const e = (from: string, to: string, input: number) => ({ from, to, input });
  const edges = [
    e("x", "mn", 0), e("y", "mn", 1), e("x", "mx", 0), e("y", "mx", 1), e("x", "pw", 0), e("y", "pw", 1),
    e("x", "cl", 0), e("lo", "cl", 1), e("hi", "cl", 2),
    e("x", "sel", 0), e("y", "sel", 1), e("bt", "sel", 2),
    e("lo", "ss", 0), e("hi", "ss", 1), e("x", "ss", 2),
    e("x", "om", 0), e("lo", "sub", 0), e("hi", "sub", 1), e("sub", "ab", 0),
    e("x", "fl", 0), e("x", "fr", 0),
    e("n1", "cr", 0), e("n2", "cr", 1), e("n1", "sc", 0), e("hs", "sc", 1),
    e("m3", "td", 0), e("n1", "td", 1), e("cr", "mxv", 0), e("sc", "mxv", 1), e("s10", "mxv", 2),
    e("n1", "clv", 0), e("n2", "clv", 1), e("cr", "clv", 2),
    e("cr", "dt", 0), e("sc", "dt", 1),
    e("mn", "s1", 0), e("mx", "s1", 1), e("s1", "s2", 0), e("pw", "s2", 1), e("s2", "s3", 0), e("cl", "s3", 1),
    e("s3", "s4", 0), e("sel", "s4", 1), e("s4", "s5", 0), e("om", "s5", 1), e("s5", "s6", 0), e("ab", "s6", 1),
    e("s6", "s7", 0), e("fl", "s7", 1), e("s7", "s8", 0), e("fr", "s8", 1), e("s8", "s9", 0), e("ss", "s9", 1),
    e("s9", "s10", 0), e("dt", "s10", 1),
    e("cr", "v1", 0), e("sc", "v1", 1), e("v1", "v2", 0), e("td", "v2", 1), e("v2", "v3", 0), e("mxv", "v3", 1),
    e("v3", "v4", 0), e("clv", "v4", 1),
    e("m4", "pv", 0), e("v4", "pv", 1),
  ];
  return {
    schemaVersion: 1, id: "node-families", target: "webgpu-forward", properties: [],
    stages: [{ stage: "vertex", nodes, edges, outputs: [{ semantic: "position", node: "pv" }] }],
  };
}

describe("P2 shader graph node families", () => {
  it("registers all 15 new ops with input arity and fixed output ports where declared", () => {
    for (const op of NEW_OPS) {
      const meta = shaderGraphNodeMetadata(op);
      expect(meta, op).toBeDefined();
      expect(shaderGraphNodeInputCount(op), op).toBeGreaterThan(0);
    }
    expect(shaderGraphNodeMetadata("cross")?.ports).toEqual([{ name: "value", direction: "output", type: "vec3f" }]);
    expect(shaderGraphNodeMetadata("transform-position")?.ports[0]).toMatchObject({ type: "vec4f" });
    expect(shaderGraphNodeMetadata("transform-position")?.stages).toEqual(["vertex"]);
    expect(shaderGraphNodeInputCount("smoothstep")).toBe(3);
    expect(shaderGraphNodeInputCount("literal")).toBe(0);
  });

  it("lowers each new op to the compiler IR with exact input tuples", () => {
    const result = lowerShaderGraphAsset(familyGraph());
    expect(result.success).toBe(true);
    const byId = new Map(result.stages![0]!.nodes.map(n => [n.id, n]));
    expect(byId.get("mn")).toMatchObject({ op: "min", inputs: ["x", "y"] });
    expect(byId.get("cl")).toMatchObject({ op: "clamp", inputs: ["x", "lo", "hi"] });
    expect(byId.get("sel")).toMatchObject({ op: "select", inputs: ["x", "y", "bt"] });
    expect(byId.get("ss")).toMatchObject({ op: "smoothstep", inputs: ["lo", "hi", "x"] });
    expect(byId.get("om")).toMatchObject({ op: "one-minus", inputs: ["x"] });
    expect(byId.get("ab")).toMatchObject({ op: "abs", inputs: ["sub"] });
    expect(byId.get("fl")).toMatchObject({ op: "floor", inputs: ["x"] });
    expect(byId.get("fr")).toMatchObject({ op: "fract", inputs: ["x"] });
    expect(byId.get("cr")).toMatchObject({ op: "cross", inputs: ["n1", "n2"] });
    expect(byId.get("sc")).toMatchObject({ op: "scale", inputs: ["n1", "hs"] });
    expect(byId.get("td")).toMatchObject({ op: "transform-direction", inputs: ["m3", "n1"] });
    expect(byId.get("mxv")).toMatchObject({ op: "mix", inputs: ["cr", "sc", "s10"] });
    expect(byId.get("pv")).toMatchObject({ op: "transform-position", inputs: ["m4", "v4"] });
  });

  it("compiles the lowered family graph to WGSL with one exact emission per new op", () => {
    const lowered = lowerShaderGraphAsset(familyGraph());
    expect(lowered.success).toBe(true);
    const property = (name: string, type: ShaderValueType, value: number | readonly number[]) =>
      ({ name, type, scope: "object", default: value });
    const asset: DeepShaderAsset = {
      schemaVersion: 1, id: "nodefamilies",
      properties: [
        property("normalTs", "vec3f", [0, 1, 0]), property("tangentTs", "vec3f", [1, 0, 0]),
        property("normalMatrix", "mat3x3f", [1, 0, 0, 0, 1, 0, 0, 0, 1]),
        property("objectToClip", "mat4x4f", [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      ],
      resources: [], attributes: [], varyings: [], keywords: [],
      techniques: [{
        id: "main", requirements: { webgpu: true },
        passes: [{
          id: "probe", kind: "depth",
          state: { topology: "triangle-list", cullMode: "back", frontFace: "ccw",
            depthCompare: "less-equal", depthWrite: true, colorWriteMask: 0 },
          vertex: { nodes: lowered.stages![0]!.nodes as unknown as ShaderNode[],
            outputs: [{ semantic: "position", node: "pv" }] },
        }],
      }],
    };
    const compiled = compileShaderPass(asset, "main", "probe",
      { features: [], limits: { maxBindGroups: 4, maxBindingsPerBindGroup: 16, maxInterStageShaderVariables: 16 } });
    expect(compiled.diagnostics).toEqual([]);
    expect(compiled.success).toBe(true);
    const code = compiled.value!.module.code;
    const expected = [
      "let n_mn: f32 = min(n_x, n_y);",
      "let n_mx: f32 = max(n_x, n_y);",
      "let n_pw: f32 = pow(n_x, n_y);",
      "let n_cl: f32 = clamp(n_x, n_lo, n_hi);",
      "let n_sel: f32 = select(n_x, n_y, n_bt);",
      "let n_ss: f32 = smoothstep(n_lo, n_hi, n_x);",
      "let n_om: f32 = 1.0 - n_x;",
      "let n_ab: f32 = abs(n_sub);",
      "let n_fl: f32 = floor(n_x);",
      "let n_fr: f32 = fract(n_x);",
      "let n_cr: vec3f = cross(n_n1, n_n2);",
      "let n_sc: vec3f = n_n1 * vec3f(n_hs);",
      "let n_td: vec3f = n_m3 * n_n1;",
      "let n_mxv: vec3f = mix(n_cr, n_sc, vec3f(n_s10));",
      "let n_clv: vec3f = clamp(n_n1, n_n2, n_cr);",
      "let n_dt: f32 = dot(n_cr, n_sc);",
      "let n_pv: vec4f = n_m4 * vec4f(n_v4, 1.0);",
    ];
    for (const line of expected) expect(code).toContain(line);
    expect(compiled.value!.sourceMap.map(entry => entry.nodeId)).toContain("pv");
  });

  it("keeps the full registry surface discoverable for the canvas palette", () => {
    const ops = shaderGraphNodeRegistry().map(meta => meta.op as string);
    expect(ops.filter(op => NEW_OPS.includes(op as never))).toHaveLength(NEW_OPS.length);
    expect(new Set(ops).size).toBe(ops.length);
  });
});
