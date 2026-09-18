import { describe, expect, it, vi } from "vitest";
import {
  commitSceneCommandTransaction,
  prepareSceneCommandTransaction,
  type SceneCommandTransactionDriver,
  type SceneCommandTransactionPlan,
} from "./sceneCommandTransaction";

const objectTarget = (sceneId = "factory") => ({ kind: "object" as const, sceneId, objectId: "pump" });
const module = (capabilities: string[] = ["studio.object", "studio.data", "studio.component"]) => ({
  id: "agent:maintenance", capabilities, permissions: ["scene.write" as const],
});
const request = (commands: readonly unknown[], overrides: Record<string, unknown> = {}) => ({
  id: "tx:maintenance-1", sceneId: "factory", baseRevision: 3, module: module(), commands, ...overrides,
});

describe("scene command transaction", () => {
  it("prepares a detached plan with stable, reviewable diff", () => {
    const input = [
      { id: "hide-pump", type: "object.set-visibility", target: objectTarget(), visible: false },
      { id: "bind-state", type: "data.apply", target: objectTarget(), values: { alarm: "high" }, timestamp: "2026-09-18T12:00:00Z" },
      { id: "update-card", type: "component.update", componentId: "status-card", patch: { visible: true } },
    ];
    const prepared = prepareSceneCommandTransaction(request(input));
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") return;
    expect(prepared.plan.diff).toEqual([
      { index: 0, commandId: "hide-pump", type: "object.set-visibility", target: "object:pump", summary: "object.set-visibility → object:pump" },
      { index: 1, commandId: "bind-state", type: "data.apply", target: "object:pump", summary: "data.apply → object:pump" },
      { index: 2, commandId: "update-card", type: "component.update", target: "component:status-card", summary: "component.update → component:status-card" },
    ]);
    expect(prepared.plan.requiredCapabilities).toEqual(["studio.component", "studio.data", "studio.object"]);
    (input[0] as { visible: boolean }).visible = true;
    expect((prepared.plan.commands[0] as { visible: boolean }).visible).toBe(false);
  });

  it("rejects the whole batch for permission, capability, duplicate, and scene errors", () => {
    const result = prepareSceneCommandTransaction(request([
      { id: "same", type: "object.set-visibility", target: objectTarget(), visible: false },
      { id: "same", type: "object.set-visibility", target: objectTarget(), visible: true },
      { id: "wrong-scene", type: "object.set-visibility", target: objectTarget("warehouse"), visible: false },
    ], { module: module(["studio.object"]) }));
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.issues.map(issue => issue.reason)).toEqual(["duplicate-command", "scene-mismatch"]);

    const denied = prepareSceneCommandTransaction(request([
      { id: "data", type: "data.apply", target: objectTarget(), values: { alarm: "high" }, timestamp: "now" },
    ], { module: module(["studio.object"]) }));
    expect(denied).toMatchObject({ status: "rejected", issues: [{ reason: "capability-denied", commandId: "data" }] });
    expect(prepareSceneCommandTransaction(request([
      { id: "hide", type: "object.set-visibility", target: objectTarget(), visible: false },
    ], { module: { ...module(), permissions: [] } }))).toMatchObject({
      status: "rejected", issues: [{ reason: "permission-denied" }],
    });
  });

  it("does not call the driver for a stale revision", async () => {
    const prepared = prepareSceneCommandTransaction(request([
      { id: "hide", type: "object.set-visibility", target: objectTarget(), visible: false },
    ]));
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") return;
    const driver = driverFor(prepared.plan, 4);
    const outcome = await commitSceneCommandTransaction(prepared.plan, driver);
    expect(outcome).toMatchObject({ status: "rejected", issue: { reason: "revision-conflict" } });
    expect(driver.apply).not.toHaveBeenCalled();
  });

  it("rolls back a partial driver result and returns a receipt", async () => {
    const prepared = prepareSceneCommandTransaction(request([
      { id: "first", type: "object.set-visibility", target: objectTarget(), visible: false },
      { id: "second", type: "object.set-visibility", target: { ...objectTarget(), objectId: "valve" }, visible: false },
    ]));
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") return;
    const driver = driverFor(prepared.plan, 3, [
      { index: 0, id: "first", type: "object.set-visibility", success: true },
      { index: 1, id: "second", type: "object.set-visibility", success: false, message: "对象已删除" },
    ]);
    const outcome = await commitSceneCommandTransaction(prepared.plan, driver);
    expect(outcome.status).toBe("rolled-back");
    expect(driver.rollback).toHaveBeenCalledOnce();
    if (outcome.status === "rolled-back") expect(outcome.receipt).toMatchObject({ status: "rolled-back", finalRevision: 3, commandIds: ["first", "second"] });
  });

  it("commits all successful commands and honors cancellation before apply", async () => {
    const prepared = prepareSceneCommandTransaction(request([
      { id: "hide", type: "object.set-visibility", target: objectTarget(), visible: false },
    ]));
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") return;
    const driver = driverFor(prepared.plan, 3);
    const committed = await commitSceneCommandTransaction(prepared.plan, driver);
    expect(committed).toMatchObject({ status: "committed", receipt: { finalRevision: 4 } });
    const controller = new AbortController(); controller.abort();
    const cancelled = await commitSceneCommandTransaction(prepared.plan, driver, controller.signal);
    expect(cancelled).toMatchObject({ status: "rejected", issue: { reason: "cancelled" } });
  });
});

function driverFor(
  plan: SceneCommandTransactionPlan,
  revision: number,
  results = plan.commands.map((command, index) => ({ index, id: command.id, type: command.type, success: true })),
): SceneCommandTransactionDriver & { apply: ReturnType<typeof vi.fn>; rollback: ReturnType<typeof vi.fn> } {
  return {
    readRevision: vi.fn(() => revision),
    apply: vi.fn(() => ({ revision: revision + 1, results })),
    rollback: vi.fn(() => revision),
  };
}
