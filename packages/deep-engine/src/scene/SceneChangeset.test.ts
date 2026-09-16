import { describe, expect, it } from "vitest";
import { SceneTransformGraph } from "./SceneTransformGraph";
import { applySceneChangeset, captureSceneChangesetInverse, createSceneChangeset,
  type SceneChangesetCommand } from "./SceneChangeset";
import type { SceneLocalTransform } from "./types";

const trs = (x: number, y: number, z: number): SceneLocalTransform =>
  ({ kind: "trs", translation: [x, y, z], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });

function graph(): SceneTransformGraph {
  const instance = new SceneTransformGraph();
  instance.create({ id: "root", localTransform: trs(0, 0, 0), localBounds: { min: [-1, -1, -1], max: [1, 1, 1] } });
  instance.create({ id: "child", parent: "root", localTransform: trs(2, 0, 0), localBounds: { min: [-1, -1, -1], max: [1, 1, 1] } });
  instance.flush();
  return instance;
}

const readStamp = (instance: SceneTransformGraph, id: string) => instance.getNode(id as never)!.lastChangedRevision;

describe("scene changeset ownership contract", () => {
  it("applies transform and hidden atomically and advances a single authority", () => {
    const instance = graph();
    const commands: SceneChangesetCommand[] = [
      { kind: "transform", nodeId: "child", expectedRevision: readStamp(instance, "child"), transform: trs(5, 1, 0) },
      { kind: "hidden", nodeId: "root", expectedRevision: readStamp(instance, "root"), hidden: true },
    ];
    const outcome = applySceneChangeset(instance, createSceneChangeset("cs-1", instance.revision, commands));
    expect(outcome.status).toBe("applied");
    if (outcome.status !== "applied") return;
    expect(outcome.flush.revision).toBe(instance.revision);
    expect(instance.getNode("child" as never)!.worldMatrix[12]).toBe(5);
    expect(instance.getNode("root" as never)!.hidden).toBe(true);
    expect(instance.getNode("child" as never)!.hidden).toBe(false);
  });

  it("projects the same changeset onto two hosts with bit-identical authority state", () => {
    const first = graph(), second = graph();
    const commands: SceneChangesetCommand[] = [
      { kind: "transform", nodeId: "child", expectedRevision: readStamp(first, "child"), transform: trs(3, 4, 5) },
    ];
    const firstOutcome = applySceneChangeset(first, createSceneChangeset("cs-2", first.revision, commands));
    const secondOutcome = applySceneChangeset(second, createSceneChangeset("cs-2", second.revision, commands));
    expect(firstOutcome.status).toBe("applied");
    expect(secondOutcome.status).toBe("applied");
    expect(JSON.stringify(first.getNode("child" as never)!.worldMatrix))
      .toBe(JSON.stringify(second.getNode("child" as never)!.worldMatrix));
  });

  it("rejects late revisions as a whole without touching the graph", () => {
    const instance = graph();
    // 每节点粒度:父节点变更不使子节点命令过期
    const childStamp = readStamp(instance, "child");
    instance.update("root" as never, { localTransform: trs(1, 1, 1) });
    instance.flush();
    expect(applySceneChangeset(instance, createSceneChangeset("cs-3a", instance.revision, [
      { kind: "transform", nodeId: "child", expectedRevision: childStamp, transform: trs(9, 9, 9) },
    ])).status).toBe("applied");
    // 子节点自身变更后,携带旧戳的命令整体拒绝
    const stale = readStamp(instance, "child");
    instance.update("child" as never, { localTransform: trs(2, 2, 2) });
    instance.flush();
    const before = instance.revision;
    const outcome = applySceneChangeset(instance, createSceneChangeset("cs-3", instance.revision, [
      { kind: "transform", nodeId: "child", expectedRevision: stale, transform: trs(9, 9, 9) },
    ]));
    expect(outcome).toEqual({ status: "rejected", rejections: [expect.objectContaining({ nodeId: "child", reason: "stale-revision" })] });
    expect(instance.revision).toBe(before);
    expect(instance.getNode("child" as never)!.worldMatrix[12]).toBe(3);
  });

  it("rejects a stale base revision and missing nodes without partial application", () => {
    const instance = graph();
    const lateBase = createSceneChangeset("cs-4", instance.revision + 3, [
      { kind: "transform", nodeId: "child", expectedRevision: readStamp(instance, "child"), transform: trs(8, 8, 8) },
    ]);
    expect(applySceneChangeset(instance, lateBase)).toEqual({ status: "rejected",
      rejections: [expect.objectContaining({ reason: "base-revision" })] });
    const missing = applySceneChangeset(instance, createSceneChangeset("cs-5", instance.revision, [
      { kind: "hidden", nodeId: "ghost", expectedRevision: 0, hidden: true },
      { kind: "transform", nodeId: "child", expectedRevision: readStamp(instance, "child"), transform: trs(6, 6, 6) },
    ]));
    expect(missing).toEqual({ status: "rejected", rejections: [expect.objectContaining({ nodeId: "ghost", reason: "missing-node" })] });
    // 全有或全无:合法命令也未被应用
    expect(instance.getNode("child" as never)!.worldMatrix[12]).toBe(2);
  });

  it("undo restores the exact prior authority through the same CAS channel", () => {
    const instance = graph();
    const worldBefore = JSON.stringify(instance.getNode("child" as never)!.worldMatrix);
    const commands: SceneChangesetCommand[] = [
      { kind: "transform", nodeId: "child", expectedRevision: readStamp(instance, "child"), transform: trs(7, 7, 7) },
      { kind: "hidden", nodeId: "child", expectedRevision: readStamp(instance, "child"), hidden: true },
    ];
    // 重复 nodeId 在构造期 fail-closed
    expect(() => createSceneChangeset("cs-6", instance.revision, commands)).toThrow(/one command per node/);
    const single: SceneChangesetCommand[] = [
      { kind: "transform", nodeId: "child", expectedRevision: readStamp(instance, "child"), transform: trs(7, 7, 7) },
    ];
    const inverse = captureSceneChangesetInverse(instance, createSceneChangeset("cs-7", instance.revision, single));
    expect(applySceneChangeset(instance, createSceneChangeset("cs-7", instance.revision, single)).status).toBe("applied");
    expect(JSON.stringify(instance.getNode("child" as never)!.worldMatrix)).not.toBe(worldBefore);
    // 迟到撤销:撤销前又发生一次变更 → 整体拒绝,不产生第二权威
    instance.update("child" as never, { localTransform: trs(1, 2, 3) });
    instance.flush();
    expect(applySceneChangeset(instance, inverse).status).toBe("rejected");
    // 恢复原始局部变换 → 同一 CAS 通道回到 worldBefore,不产生第二权威
    expect(applySceneChangeset(instance, createSceneChangeset("cs-8", instance.revision, [
      { kind: "transform", nodeId: "child", expectedRevision: readStamp(instance, "child"), transform: trs(2, 0, 0) },
    ])).status).toBe("applied");
    expect(JSON.stringify(instance.getNode("child" as never)!.worldMatrix)).toBe(worldBefore);
  });

  it("keeps changesets pure data across JSON round-trips", () => {
    const instance = graph();
    const original = createSceneChangeset("cs-9", instance.revision, [
      { kind: "transform", nodeId: "child", expectedRevision: readStamp(instance, "child"), transform: trs(4, 5, 6) },
    ]);
    const revived = JSON.parse(JSON.stringify(original)) as typeof original;
    expect(applySceneChangeset(instance, revived).status).toBe("applied");
    expect(instance.getNode("child" as never)!.worldMatrix[12]).toBe(4);
  });

  it("fails closed on invalid transforms without mutating the graph", () => {
    const instance = graph();
    const revisionBefore = instance.revision, stampBefore = readStamp(instance, "child");
    // 构造期即拦截非有限值
    expect(() => createSceneChangeset("cs-10", instance.revision, [
      { kind: "transform", nodeId: "child", expectedRevision: stampBefore,
        transform: { kind: "trs", translation: [Number.NaN, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } },
    ])).toThrow(/non-finite/);
    // 图侧细粒度校验(矩阵长度)经数据复活绕过构造器后,由事务回滚兜底
    const revived = JSON.parse(JSON.stringify(createSceneChangeset("cs-11", instance.revision, [
      { kind: "transform", nodeId: "child", expectedRevision: stampBefore, transform: trs(3, 3, 3) },
    ]))) as SceneChangesetCommand extends never ? never : { commands: [{ transform: { kind: string; matrix: number[] } }] };
    (revived.commands[0]!.transform as { kind: string }).kind = "matrix";
    (revived.commands[0]!.transform as unknown as { matrix: number[] }).matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0];
    const outcome = applySceneChangeset(instance, revived as unknown as Parameters<typeof applySceneChangeset>[1]);
    expect(outcome.status).toBe("rejected");
    expect(instance.revision).toBe(revisionBefore);
    expect(instance.getNode("child" as never)!.lastChangedRevision).toBe(stampBefore);
  });
});
