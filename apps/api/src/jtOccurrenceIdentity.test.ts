import { describe, expect, it } from "vitest";
import type { JtMeshInstance, JtSceneNode } from "@bim-studio/jt-reader";
import { buildJtOccurrences, jtInstanceElementId, jtOccurrenceElementId } from "./jtOccurrenceIdentity.js";

const node = (objectId: number, childObjectIds: number[] = []): JtSceneNode => ({
  objectId, kind: "group", label: `Part ${objectId}`, childObjectIds, attributeObjectIds: [], properties: { Material: "Steel" },
});
const instance = (pathObjectIds: number[]): JtMeshInstance => ({
  id: "transient-counter-17", meshId: "segment:lod-0", sceneNodeObjectId: pathObjectIds.at(-1)!, pathObjectIds,
  worldTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
});
const graph = () => ({ nodes: [node(0, [1, 2]), node(1, [3]), node(2, [3]), node(3)], rootObjectIds: [0] });

describe("JT occurrence identity", () => {
  it("keeps shared prototypes distinct without copying invented instance properties", () => {
    const g = graph();
    const result = buildJtOccurrences(g, [instance([0, 1, 3]), instance([0, 2, 3])]);
    expect(result.all).toHaveLength(5);
    expect(new Set(result.all.map((x) => x.id)).size).toBe(5);
    const copies = result.all.filter((x) => x.source.objectId === 3);
    expect(copies.map((x) => x.prototypeId)).toEqual(["jt-node:3", "jt-node:3"]);
    expect(copies[0]!.source).toBe(copies[1]!.source);
    expect(copies[0]!.meshIds).not.toEqual(copies[1]!.meshIds);
    expect(copies.map((x) => x.parentId)).toEqual(["jt-occurrence:0/1", "jt-occurrence:0/2"]);
  });

  it("uses source paths rather than source-array order or traversal counters", () => {
    const g = graph();
    const a = buildJtOccurrences(g, [instance([0, 1, 3]), instance([0, 2, 3])]);
    g.nodes.reverse();
    g.nodes.find((x) => x.objectId === 0)!.childObjectIds.reverse();
    const reordered = { ...instance([0, 1, 3]), id: "different-counter-999" };
    const b = buildJtOccurrences(g, [instance([0, 2, 3]), reordered]);
    const identities = (rows: typeof a.all) => rows.map((x) => [x.id, ...x.meshIds].join("|")).sort();
    expect(identities(a.all)).toEqual(identities(b.all));
    expect(jtInstanceElementId(reordered)).toBe(jtInstanceElementId(instance([0, 1, 3])));
  });

  it.each([[], [0, -1], [0, 1.5], [0, NaN], [0, 1, 0]].map((path) => [path]))("rejects invalid or cyclic identity paths %j", (path) => {
    expect(() => jtOccurrenceElementId(path!)).toThrow("JT 装配路径");
  });

  it("rejects missing nodes, duplicate paths/prototypes and unmapped instance paths", () => {
    expect(() => buildJtOccurrences({ nodes: [node(0, [9])], rootObjectIds: [0] }, [])).toThrow("缺失节点");
    expect(() => buildJtOccurrences({ nodes: [node(0, [1, 1]), node(1)], rootObjectIds: [0] }, [])).toThrow("重复路径");
    expect(() => buildJtOccurrences({ nodes: [node(0), node(0)], rootObjectIds: [0] }, [])).toThrow("编号重复");
    expect(() => buildJtOccurrences({ nodes: [node(0)], rootObjectIds: [0, 0] }, [])).toThrow("重复路径");
    expect(() => buildJtOccurrences(graph(), [instance([0, 3])])).toThrow("不存在的装配路径");
    expect(() => buildJtOccurrences(graph(), [instance([0, 1, 3]), instance([0, 1, 3])])).toThrow("同一装配路径重复");
    expect(() => jtInstanceElementId({ ...instance([0, 1, 3]), sceneNodeObjectId: 2 })).toThrow("末端不匹配");
    expect(() => jtInstanceElementId({ ...instance([0, 1, 3]), meshId: "" })).toThrow("缺少网格身份");
  });
});
