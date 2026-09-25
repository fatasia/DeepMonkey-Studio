import { describe, expect, it } from "vitest";
import type { RenderPacket } from "../renderPacket.js";
import { buildDeepRuntimePackage, validateDeepRuntimePackage } from "./index.js";
import { runtimeContentSha256, runtimePackageSha256 } from "./hash.js";

/** 两个实例同属一个作者节点(多对一)的最小包输入;bindings 传 null 表示旧包(无映射)。 */
function input(bindings: readonly { nodeId: string; instanceIds: readonly string[] }[] | null = [
  { nodeId: "node-a", instanceIds: ["i-1", "i-2"] }]): Parameters<typeof buildDeepRuntimePackage>[0] {
  const value = {
    geometries: [{ id: "g", revision: 1,
      vertices: new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]) }],
    materials: [{ id: "m", baseColor: [.5, .5, .5], metallic: 0, roughness: .5 }],
    instances: [
      { id: "i-1", geometry: "g", material: "m", transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
      { id: "i-2", geometry: "g", material: "m", transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 0, 0, 1] }],
    ...(bindings === null ? {} : { objectBindings: bindings }),
  } as unknown as RenderPacket;
  return { packageId: "deep.runtime.bindings", packageVersion: "1.0.0",
    renderPacket: { id: "scene.main", revision: 1, value } };
}
/** 改动顶层可选字段后重签包哈希,再交给校验器。 */
function resigned(mutate: (value: Record<string, unknown>) => void) {
  const value = JSON.parse(JSON.stringify(buildDeepRuntimePackage(input()))) as Record<string, unknown>;
  mutate(value);
  (value.packageHash as { value: string }).value = runtimePackageSha256(value);
  return validateDeepRuntimePackage(value);
}

describe("runtime package node-level object bindings", () => {
  it("lifts author objectBindings to the package top level and keeps them out of the render-packet payload", () => {
    const runtime = buildDeepRuntimePackage(input());
    expect(runtime.objectBindings).toEqual([{ nodeId: "node-a", instanceIds: ["i-1", "i-2"] }]);
    // Native 契约对 render-packet payload 拒绝未知字段;映射必须只住在包顶层。
    expect(Object.hasOwn(runtime.payloads["scene.main"]!, "objectBindings")).toBe(false);
    expect(validateDeepRuntimePackage(JSON.parse(JSON.stringify(runtime))).valid).toBe(true);
  });

  it("keeps legacy packages valid when objectBindings are absent", () => {
    const runtime = buildDeepRuntimePackage(input(null));
    expect(runtime.objectBindings).toBeUndefined();
    expect(validateDeepRuntimePackage(JSON.parse(JSON.stringify(runtime))).valid).toBe(true);
  });

  it("rejects empty, duplicated or malformed bindings instead of masking them as valid", () => {
    expect(resigned(value => { (value.objectBindings as { nodeId: string }[])[0]!.nodeId = ""; })
      .issues[0]?.message).toMatch(/Node id must be non-empty/);
    expect(resigned(value => { (value.objectBindings as { instanceIds: string[] }[])[0]!.instanceIds = []; })
      .issues[0]?.message).toMatch(/at least one instance/);
    expect(resigned(value => { (value.objectBindings as { instanceIds: string[] }[])[0]!.instanceIds = ["i-1", "i-1"]; })
      .issues[0]?.message).toMatch(/unique within a binding/);
    expect(resigned(value => { value.objectBindings = [{ nodeId: "a", instanceIds: ["i-1"] }, { nodeId: "a", instanceIds: ["i-2"] }]; })
      .issues[0]?.message).toMatch(/Duplicate object binding for node: a/);
    expect(resigned(value => { (value.objectBindings as { instanceIds: string[] }[])[0]!.instanceIds = ["i-1", ""]; })
      .issues[0]?.message).toMatch(/Instance id must be non-empty/);
  });

  it("refuses objectBindings inside the render-packet payload (unknown field)", () => {
    const value = JSON.parse(JSON.stringify(buildDeepRuntimePackage(input()))) as Record<string, unknown>;
    const packet = value.payloads["scene.main"] as Record<string, unknown>;
    packet.objectBindings = value.objectBindings;
    const resources = value.resources as { id: string; contentHash: { value: string } }[];
    resources.find(entry => entry.id === "scene.main")!.contentHash.value = runtimeContentSha256(packet);
    (value.packageHash as { value: string }).value = runtimePackageSha256(value);
    const result = validateDeepRuntimePackage(value);
    expect(result.valid).toBe(false);
    expect(result.issues[0]).toMatchObject({ path: "$.payloads.scene.main.objectBindings", message: expect.stringMatching(/Unknown field/) });
  });

  it("rejects invalid author mappings at build time instead of publishing a lying package", () => {
    expect(() => buildDeepRuntimePackage(input([{ nodeId: "", instanceIds: ["i-1"] }])))
      .toThrow(/Node id must be non-empty/);
  });
});
