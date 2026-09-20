import { describe, expect, it } from "vitest";
import { validateClusterLodDag, type ClusterLodDagDescriptor } from "./clusterLodDag.js";

function twoLevelDag(): ClusterLodDagDescriptor {
  return {
    geometryId: "wall-a",
    leafTriangleTotal: 12,
    nodes: [
      { id: "l0-a", level: 0, error: 0, firstTriangle: 0, triangleCount: 6, children: [],
        boundsMin: [0, 0, 0], boundsMax: [1, 1, 1] },
      { id: "l0-b", level: 0, error: 0, firstTriangle: 6, triangleCount: 6, children: [],
        boundsMin: [1, 0, 0], boundsMax: [2, 1, 1] },
      { id: "l1-root", level: 1, error: 0.5, firstTriangle: 0, triangleCount: 4, children: ["l0-a", "l0-b"],
        boundsMin: [0, 0, 0], boundsMax: [2, 1, 1] },
    ],
  };
}

describe("cluster lod dag contract", () => {
  it("accepts a well-formed two-level dag", () => {
    expect(validateClusterLodDag(twoLevelDag())).toEqual({ valid: true });
  });

  it("rejects unknown children and inverted levels", () => {
    const dag = twoLevelDag();
    const broken: ClusterLodDagDescriptor = { ...dag,
      nodes: dag.nodes.map(node => node.id === "l1-root" ? { ...node, children: ["l0-a", "ghost"] } : node) };
    expect(validateClusterLodDag(broken)).toEqual({ valid: false, reason: "Node l1-root references unknown child ghost." });
    const inverted: ClusterLodDagDescriptor = { ...dag,
      nodes: dag.nodes.map(node => node.id === "l0-a" ? { ...node, level: 2 } : node) };
    expect(validateClusterLodDag(inverted).valid).toBe(false);
  });

  it("rejects uncovered triangles and duplicate ids", () => {
    expect(validateClusterLodDag({ ...twoLevelDag(), leafTriangleTotal: 99 }).valid).toBe(false);
    const duplicated = twoLevelDag();
    const [first, second, root] = duplicated.nodes;
    const conflict: ClusterLodDagDescriptor = { ...duplicated, nodes: [
      first!, { ...second!, id: first!.id }, root!,
    ] };
    expect(validateClusterLodDag(conflict)).toEqual({ valid: false, reason: "Duplicate DAG node id: l0-a." });
  });

  it("keeps leaf-level parents out of the graph", () => {
    const dag = twoLevelDag();
    const withLeafParent: ClusterLodDagDescriptor = { ...dag,
      nodes: dag.nodes.map(node => node.id === "l0-a"
        ? { ...node, children: ["l0-b"] } : node) };
    const result = validateClusterLodDag(withLeafParent);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("Node l0-a has children at the leaf level.");
  });
});
