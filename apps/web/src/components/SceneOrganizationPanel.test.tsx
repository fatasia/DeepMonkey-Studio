import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SceneOrganizationPanel } from "./SceneOrganizationPanel";

describe("SceneOrganizationPanel", () => {
  it("exposes compact groups and objects as a keyboard-selectable tree", () => {
    const html = renderToStaticMarkup(
      <SceneOrganizationPanel
        locale="zh-CN"
        objects={[
          { id: "pump-1", name: "循环泵", kind: "model", visible: true, locked: false },
          { id: "valve-1", name: "阀门", kind: "primitive", visible: true, locked: false },
        ]}
        selectedIds={new Set(["pump-1"])}
        selectionSets={[
          { id: "group-1", name: "泵房设备", kind: "group", objectIds: ["pump-1"] },
          { id: "saved-1", name: "巡检对象", kind: "selection", objectIds: ["valve-1"] },
        ]}
        lastDeletedSelectionSet={undefined}
        isolationActive={false}
        onClose={vi.fn()}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        onShow={vi.fn()}
        onLock={vi.fn()}
        onIsolate={vi.fn()}
        onRestoreIsolation={vi.fn()}
        onCreateSelectionSet={vi.fn()}
        onCreateGroup={vi.fn()}
        onMoveObjects={vi.fn()}
        onReorderGroup={vi.fn()}
        onRenameGroup={vi.fn()}
        onUpdateSelectionSet={vi.fn()}
        onApplySelectionSet={vi.fn()}
        onDeleteSelectionSet={vi.fn()}
        onRestoreDeletedSelectionSet={vi.fn()}
      />,
    );

    expect(html).toContain('role="tree"');
    expect(html).toContain('role="treeitem"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("收起编组");
    expect(html).toContain("用当前选择更新");
    expect(html).toContain("删除保存的选择");
    expect(html).toContain("scene-tree-children");
    expect(html.indexOf("泵房设备")).toBeLessThan(html.indexOf("循环泵"));
    expect(html.indexOf("循环泵")).toBeLessThan(html.indexOf("阀门"));
  });
});
