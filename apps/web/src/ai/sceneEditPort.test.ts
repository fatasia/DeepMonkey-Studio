import { afterEach, describe, expect, it, vi } from "vitest";
import type { SceneCommand } from "@bim-studio/scene-sdk";
import { primitiveCreationHarness } from "../studio/editorPrimitiveCreation.testUtils";
import type { SceneEditTransaction } from "../hooks/useSceneHistoryState";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import { createSceneEditPort, type SceneEditPortHost } from "./sceneEditPort";

const ref = (id: string) => ({ kind: "object" as const, sceneId: "s", objectId: id });
const create = (id: string): SceneCommand => ({ id: `create-${id}`, type: "object.create-primitive", target: ref(id), name: "设备", kind: "box", color: "#1683ff" });
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(dispose => dispose()); });

function setup() {
  const f = primitiveCreationHarness();
  cleanup.push(f.cleanup);
  const engine = f.engine as unknown as ViewerEngine;
  // 夹具引擎没有材质读口;端口只依赖其只读形状。
  (engine as unknown as { getModelMaterialState: () => undefined }).getModelMaterialState = () => undefined;
  (engine as unknown as { getSelected: () => undefined }).getSelected = () => undefined;
  const txn: SceneEditTransaction & { committed: number; rolledBack: number } = {
    label: "t", before: undefined, active: true, committed: 0, rolledBack: 0,
    commit() { this.committed += 1; }, rollback() { this.rolledBack += 1; return undefined; },
  };
  const labels: string[] = [];
  let top: string | undefined;
  const host: SceneEditPortHost = {
    sceneId: "s", engine: () => engine, unavailableReason: () => undefined, authoring: () => undefined,
    beginTransaction: label => { labels.push(label); return txn; }, syncDraft: vi.fn(), undoLabel: () => top, undo: vi.fn(async () => { top = undefined; }),
  };
  return { f, port: createSceneEditPort(host), host, txn, labels, setTop: (value: string) => { top = value; } };
}

describe("scene edit port over the real author engine", () => {
  it("applies a batch atomically inside ONE author transaction and reads back observed state", async () => {
    const { port, txn, labels, host } = setup();
    const before = port.readState();
    expect(before.objects.map(item => item.id)).toEqual(["instance"]);
    const outcome = await port.apply([create("n"), { id: "mv", type: "object.set-transform", target: ref("n"), position: [4, 2, -3] }], "AI 改动 1", "tx-1");
    expect(outcome.status).toBe("committed");
    expect(labels).toEqual(["AI 改动 1"]);
    expect(txn.committed).toBe(1);
    expect(txn.rolledBack).toBe(0);
    expect(host.syncDraft).toHaveBeenCalledOnce();
    expect(port.readState().objects.find(item => item.id === "n")).toMatchObject({ position: [4, 2, -3] });
  });

  it("rolls the whole batch back (no half-applied objects) and closes the transaction without an undo entry", async () => {
    const { port, txn, f } = setup();
    const outcome = await port.apply([create("n"), { id: "bad", type: "object.set-parent", target: ref("n"), parentId: null }], "AI 改动 2", "tx-2");
    expect(outcome.status).toBe("rolled-back");
    expect(f.models.has("n")).toBe(false);
    expect(txn.committed).toBe(0);
    expect(txn.rolledBack).toBe(1);
  });

  it("rejects invalid or capability-less batches before touching the scene", async () => {
    const { port, f } = setup();
    const outcome = await port.apply([{ id: "u", type: "unity.scene.switch", componentId: "c", scene: "x" } as SceneCommand], "AI 改动 3", "tx-3");
    expect(outcome.status).toBe("rejected");
    expect(f.models.size).toBe(1);
  });

  it("undo only fires when the batch is on top of the history stack", async () => {
    const { port, host, setTop } = setup();
    setTop("别人的编辑");
    expect(await port.undo("AI 改动 1")).toMatchObject({ ok: false });
    expect(host.undo).not.toHaveBeenCalled();
    setTop("AI 改动 1");
    expect(await port.undo("AI 改动 1")).toEqual({ ok: true });
    expect(host.undo).toHaveBeenCalledOnce();
  });
});
