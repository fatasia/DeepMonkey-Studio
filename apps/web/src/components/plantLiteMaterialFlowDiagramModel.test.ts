import { describe, expect, it } from "vitest";
import type { PlantLiteModel } from "@bim-studio/contracts";
import { buildPlantLiteMaterialFlowDiagram } from "./plantLiteMaterialFlowDiagramModel";
import type { PlantLiteEdgeFlow } from "./plantLiteMaterialFlowModel";

const model: PlantLiteModel = {
  id: "branched-flow",
  name: "分支物流",
  nodes: [
    { id: "source", name: "来料入口", kind: "source", interarrivalTime: { kind: "deterministic", value: 1 } },
    { id: "station-a", name: "装配工位 A", kind: "station", processingTime: { kind: "deterministic", value: 2 } },
    { id: "station-b", name: "装配工位 B", kind: "station", processingTime: { kind: "deterministic", value: 2 } },
    { id: "sink", name: "成品出口", kind: "sink" },
  ],
  edges: [
    { id: "source-a", from: "source", to: "station-a" },
    { id: "source-a-backup", from: "source", to: "station-a" },
    { id: "source-b", from: "source", to: "station-b" },
    { id: "a-sink", from: "station-a", to: "sink" },
    { id: "b-sink", from: "station-b", to: "sink" },
  ],
};

const edgeFlows: PlantLiteEdgeFlow[] = [
  flow("source-a", "source", "来料入口", "station-a", "装配工位 A", null, 9, "parallel-route-total"),
  flow("source-a-backup", "source", "来料入口", "station-a", "装配工位 A", null, 9, "parallel-route-total"),
  flow("source-b", "source", "来料入口", "station-b", "装配工位 B", 4, 4, "exact"),
  flow("a-sink", "station-a", "装配工位 A", "sink", "成品出口", 7, 7, "exact"),
  flow("b-sink", "station-b", "装配工位 B", "sink", "成品出口", 0, 0, "exact"),
];

describe("buildPlantLiteMaterialFlowDiagram", () => {
  it("groups parallel edges into one endpoint route without double counting their trace total", () => {
    const diagram = buildPlantLiteMaterialFlowDiagram(model, edgeFlows, "horizontal");
    const parallel = diagram.links.find((link) => link.fromNodeId === "source" && link.toNodeId === "station-a");

    expect(diagram.links).toHaveLength(4);
    expect(parallel).toMatchObject({
      capturedTransferCount: 9,
      attribution: "parallel-route-total",
      edgeIds: ["source-a", "source-a-backup"],
    });
    expect(diagram.maximumCapturedTransferCount).toBe(9);
    expect(diagram.hasParallelRoutes).toBe(true);
  });

  it("uses observed volume for relative line emphasis while preserving zero-volume routes", () => {
    const diagram = buildPlantLiteMaterialFlowDiagram(model, edgeFlows, "horizontal");
    const strongest = diagram.links.find((link) => link.capturedTransferCount === 9)!;
    const smaller = diagram.links.find((link) => link.capturedTransferCount === 4)!;
    const empty = diagram.links.find((link) => link.capturedTransferCount === 0)!;

    expect(strongest.strokeWidth).toBeGreaterThan(smaller.strokeWidth);
    expect(smaller.strokeWidth).toBeGreaterThan(empty.strokeWidth);
    expect(empty.strokeWidth).toBe(1.5);
    expect(empty.path).toMatch(/^M /);
  });

  it("provides a vertical compact layout with the same evidence and downward flow", () => {
    const wide = buildPlantLiteMaterialFlowDiagram(model, edgeFlows, "horizontal");
    const compact = buildPlantLiteMaterialFlowDiagram(model, edgeFlows, "vertical");
    const compactSource = compact.nodes.find((node) => node.id === "source")!;
    const compactSink = compact.nodes.find((node) => node.id === "sink")!;

    expect(compact.links.map((link) => link.capturedTransferCount)).toEqual(wide.links.map((link) => link.capturedTransferCount));
    expect(compactSink.y).toBeGreaterThan(compactSource.y);
    expect(compact.height).toBeGreaterThan(compact.width / 2);
  });
});

function flow(
  edgeId: string,
  fromNodeId: string,
  fromNodeName: string,
  toNodeId: string,
  toNodeName: string,
  capturedTransferCount: number | null,
  routeCapturedTransferCount: number,
  attribution: PlantLiteEdgeFlow["attribution"],
): PlantLiteEdgeFlow {
  return { edgeId, fromNodeId, fromNodeName, toNodeId, toNodeName, capturedTransferCount, routeCapturedTransferCount, attribution };
}
