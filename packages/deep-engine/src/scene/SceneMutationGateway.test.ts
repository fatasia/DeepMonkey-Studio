import { describe, expect, it } from "vitest";
import { SceneMutationGateway, type SceneMutationCommandParser } from "./SceneMutationGateway";
import { SceneTransformGraph } from "./SceneTransformGraph";
import type { SceneLocalTransform } from "./types";

const identityParser: SceneMutationCommandParser = { parse: (input) => input };
const trs = (x: number, y: number, z: number): SceneLocalTransform => ({
  kind: "trs", translation: [x, y, z], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
});

function fixture() {
  const graph = new SceneTransformGraph();
  graph.create({ id: "root", localTransform: trs(0, 0, 0) });
  graph.create({ id: "pump", parent: "root", localTransform: trs(1, 0, 0) });
  graph.create({ id: "valve", parent: "root", localTransform: trs(0, 1, 0) });
  graph.flush();
  return { graph, gateway: new SceneMutationGateway(graph, { sceneId: "factory", parser: identityParser }) };
}

const target = (objectId: string, sceneId = "factory") => ({ kind: "object", sceneId, objectId });

describe("SceneMutationGateway", () => {
  it("maps partial Scene API transforms and visibility into the authoritative graph", () => {
    const { graph, gateway } = fixture();
    const outcome = gateway.execute("script:42", [
      { id: "move", type: "object.set-transform", target: target("pump"), position: [12, 2, 8], rotation: [0, Math.PI, 0] },
      { id: "hide", type: "object.set-visibility", target: target("valve"), visible: false },
    ]);

    expect(outcome.status).toBe("applied");
    if (outcome.status === "applied") expect(outcome.flush.changedNodeIds).toEqual(["pump", "valve"]);
    expect(graph.getNode("pump")!.localTransform).toEqual({
      kind: "trs", translation: [12, 2, 8], rotation: [0, 1, 0, expect.closeTo(0)], scale: [1, 1, 1],
    });
    expect(graph.getNode("valve")!.hidden).toBe(true);
  });

  it("keeps preparation side-effect free and rejects a stale prepared batch atomically", () => {
    const { graph, gateway } = fixture();
    const prepared = gateway.prepare("script:stale", [
      { id: "move", type: "object.set-transform", target: target("pump"), position: [9, 0, 0] },
      { id: "hide", type: "object.set-visibility", target: target("valve"), visible: false },
    ]);
    expect(prepared.status).toBe("prepared");
    expect(graph.getNode("pump")!.localTransform).toEqual(trs(1, 0, 0));
    if (prepared.status !== "prepared") return;

    graph.update("root", { hidden: true });
    graph.flush();
    const outcome = gateway.commit(prepared);

    expect(outcome).toEqual({ status: "rejected", rejections: [expect.objectContaining({ reason: "base-revision" })] });
    expect(graph.getNode("pump")!.localTransform).toEqual(trs(1, 0, 0));
    expect(graph.getNode("valve")!.hidden).toBe(false);
  });

  it("advances the authority revision for a visibility-only commit", () => {
    const { graph, gateway } = fixture();
    const revision = graph.revision;
    const outcome = gateway.execute("script:visibility", [
      { id: "hide", type: "object.set-visibility", target: target("pump"), visible: false },
    ]);
    expect(outcome.status).toBe("applied");
    if (outcome.status !== "applied") return;
    expect(outcome.revision).toBe(revision + 1);
    expect(outcome.flush.changedNodeIds).toEqual(["pump"]);
    expect(graph.getNode("pump")!.hidden).toBe(true);
  });

  it.each([
    [{ id: "material", type: "material.set", target: target("pump"), patch: {} }, "unsupported-command"],
    [{ id: "mesh", type: "object.set-visibility", target: { kind: "mesh", sceneId: "factory", objectId: "pump", meshId: "part" }, visible: false }, "unsupported-target"],
    [{ id: "other", type: "object.set-visibility", target: target("pump", "warehouse"), visible: false }, "scene-mismatch"],
    [{ id: "missing", type: "object.set-transform", target: target("ghost"), position: [1, 2, 3] }, "missing-node"],
  ])("rejects unsupported or invalid mapping without mutation", (command, reason) => {
    const { graph, gateway } = fixture();
    const revision = graph.revision;
    const outcome = gateway.execute("script:reject", [command]);
    expect(outcome).toEqual({ status: "rejected", issues: [expect.objectContaining({ reason })] });
    expect(graph.revision).toBe(revision);
  });

  it("coalesces repeated patches and removes final no-ops from a batch", () => {
    const { gateway } = fixture();
    const prepared = gateway.prepare("script:minimal", [
      { id: "move", type: "object.set-transform", target: target("pump"), position: [2, 0, 0] },
      { id: "scale", type: "object.set-transform", target: target("pump"), scale: [2, 2, 2] },
      { id: "show", type: "object.set-visibility", target: target("root"), visible: true },
      { id: "empty", type: "object.set-transform", target: target("valve") },
    ]);

    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") return;
    expect(prepared.changeset.commands).toEqual([{
      kind: "transform", nodeId: "pump", expectedRevision: 0,
      transform: { kind: "trs", translation: [2, 0, 0], rotation: [0, 0, 0, 1], scale: [2, 2, 2] },
    }]);
    expect(prepared.skippedCommandCount).toBe(3);
  });

  it("fails closed when v1 cannot represent two mutation kinds for one node", () => {
    const { graph, gateway } = fixture();
    const outcome = gateway.execute("script:conflict", [
      { id: "move", type: "object.set-transform", target: target("pump"), position: [2, 0, 0] },
      { id: "hide", type: "object.set-visibility", target: target("pump"), visible: false },
    ]);
    expect(outcome).toEqual({ status: "rejected", issues: [expect.objectContaining({ reason: "conflicting-target" })] });
    expect(graph.getNode("pump")!.localTransform).toEqual(trs(1, 0, 0));
    expect(graph.getNode("pump")!.hidden).toBe(false);
  });

  it("does not invent a TRS decomposition for matrix-authored nodes", () => {
    const graph = new SceneTransformGraph();
    graph.create({ id: "matrix-node", localTransform: { kind: "matrix", matrix: [
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 5, 6, 1,
    ] } });
    graph.flush();
    const gateway = new SceneMutationGateway(graph, { sceneId: "factory", parser: identityParser });
    const outcome = gateway.execute("script:matrix", [
      { id: "move", type: "object.set-transform", target: target("matrix-node"), position: [0, 0, 0] },
    ]);
    expect(outcome).toEqual({ status: "rejected", issues: [expect.objectContaining({ reason: "unsupported-transform" })] });
  });
});
