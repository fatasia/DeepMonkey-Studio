import { describe, expect, it } from "vitest";
import { assertFactoryFlowModel, validateFactoryFlowModel, type FactoryFlowModel } from "./model.js";

const VALID_MODEL: FactoryFlowModel = {
  id: "line-a",
  name: "Line A",
  nodes: [
    { id: "source", name: "Source", kind: "source", interarrivalTimeMs: 1_000, maxItems: 3 },
    { id: "process", name: "Assembly", kind: "process", cycleTimeMs: 500 },
    { id: "sink", name: "Finished", kind: "sink" }
  ],
  edges: [
    { id: "e1", from: "source", to: "process" },
    { id: "e2", from: "process", to: "sink" }
  ]
};

describe("factory flow model", () => {
  it("accepts and defensively clones a small deterministic line", () => {
    const validation = validateFactoryFlowModel(VALID_MODEL);
    expect(validation).toMatchObject({ valid: true, model: { id: "line-a" } });
    if (validation.valid) {
      validation.model.name = "Changed";
      expect(VALID_MODEL.name).toBe("Line A");
    }
  });

  it("reports unknown endpoints and invalid node timing without throwing", () => {
    const input = structuredClone(VALID_MODEL);
    input.nodes[0]!.interarrivalTimeMs = 0;
    input.edges[1]!.to = "missing";
    expect(validateFactoryFlowModel(input)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([
        { path: "$.nodes[0].interarrivalTimeMs", message: "must be a positive finite number" },
        { path: "$.edges[1].to", message: "unknown target node" }
      ])
    });
  });

  it("rejects cyclic graphs so draining always terminates", () => {
    const cyclic: FactoryFlowModel = {
      id: "cycle",
      name: "Cycle",
      nodes: [
        { id: "source", name: "Source", kind: "source", interarrivalTimeMs: 100 },
        { id: "a", name: "A", kind: "buffer", capacity: 1 },
        { id: "b", name: "B", kind: "buffer", capacity: 1 },
        { id: "sink", name: "Sink", kind: "sink" }
      ],
      edges: [
        { id: "e1", from: "source", to: "a" },
        { id: "e2", from: "a", to: "b", priority: 0 },
        { id: "e3", from: "b", to: "a", priority: 0 },
        { id: "e4", from: "b", to: "sink", priority: 1 }
      ]
    };
    expect(() => assertFactoryFlowModel(cyclic)).toThrow("flow graph must be acyclic");
  });
});
