import { describe, expect, it, vi } from "vitest";
import { createDashboardContentController } from "./dashboardContentController";

type Context = Parameters<typeof createDashboardContentController>[0];
function fixture(locked: boolean, peerLocked = false) {
  const node = { id: "text", kind: "data-widget", locked, widget: { type: "text", title: "Title", sampleData: { sourceId: "shared", rows: [] } } };
  const peer = { ...node, id: "peer", locked: peerLocked };
  const onCommand = vi.fn();
  const controller = createDashboardContentController({
    locale: "zh-CN", page: { id: "page", nodes: [node, peer] }, selectedNode: node,
    selectedDataNodes: [], onCommand, setNodeNameError: vi.fn(), fieldsByProduct: {},
  } as unknown as Context);
  return { controller, onCommand };
}

describe("locked dashboard content", () => {
  it("rejects content, naming, data source and background writes to a locked node", async () => {
    const { controller, onCommand } = fixture(true);
    controller.updateDataWidget({ title: "Changed" });
    controller.commitNodeName("Changed");
    controller.selectDataProduct("dataset:other");
    controller.clearComponentBackground();
    await controller.uploadComponentBackground({} as File);
    expect(onCommand).not.toHaveBeenCalled();
  });
  it("keeps shared sample updates atomic when another linked node is locked", () => {
    const { controller, onCommand } = fixture(false, true);
    controller.updateDataWidget({ sampleData: { sourceId: "shared", rows: [] } as never });
    expect(onCommand).not.toHaveBeenCalled();
    controller.updateDataWidget({ title: "Allowed" });
    expect(onCommand).toHaveBeenCalledTimes(1);
  });
});
