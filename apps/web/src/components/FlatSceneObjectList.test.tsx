import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { GlobalLightingState } from "@bim-studio/contracts";
import type { LoadedSceneModel } from "../viewer/ViewerEngine";
import { FlatSceneObjectList } from "./FlatSceneObjectList";

describe("FlatSceneObjectList", () => {
  it("keeps an empty object tree quiet instead of rendering a second creation workflow", () => {
    const html = renderToStaticMarkup(<FlatSceneObjectList
      locale="zh-CN" studio engine={undefined} modelRows={[]} empty
      lighting={{ lights: [] } as unknown as GlobalLightingState} selectedLightId=""
      primitives={[]} measurements={[]} annotations={[]} spaces={[]} groups={[]} organizationObjects={[]}
      onRevision={vi.fn()} onLightSelect={vi.fn()}
      onLightUpdate={vi.fn()} onLightTransform={vi.fn()} onLightRemove={vi.fn()} onEnvironmentOpen={vi.fn()}
      onPrimitiveRemove={vi.fn()} onMeasurementRemove={vi.fn()} onAnnotationUpdate={vi.fn()} onAnnotationRemove={vi.fn()}
      onSpaceFocus={vi.fn()} onSpaceVisibilityChange={vi.fn()} onSelectGroup={vi.fn()} onRenameGroup={vi.fn()}
      onGroupVisibilityChange={vi.fn()} onGroupLockChange={vi.fn()}
    />);
    expect(html).not.toContain("还没有场景对象");
    expect(html).not.toContain("创建方盒");
  });

  it("renders groups inside the only scene layer tree without duplicating their members", () => {
    const object = { id: "pump", name: "循环泵", kind: "primitive", visible: true, opacity: 1 } as LoadedSceneModel;
    const html = renderToStaticMarkup(<FlatSceneObjectList
      locale="zh-CN" studio engine={undefined} modelRows={[{ key: "instance:root-model", render: () => <span>根模型</span> }]} empty={false}
      rootLayerOrder={[{ kind: "object", id: "root-model" }, { kind: "group", id: "group:pump-room" }]}
      lighting={{ lights: [] } as unknown as GlobalLightingState} selectedLightId="" selectedObjectId="pump"
      selectedObjectIds={new Set(["pump"])}
      primitives={[object]} measurements={[]} annotations={[]} spaces={[]}
      groups={[{ id: "group:pump-room", name: "泵房设备", kind: "group", objectIds: ["pump"] }]}
      organizationObjects={[{ id: "pump", name: "循环泵", kind: "primitive", visible: true, locked: false }]}
      onRevision={vi.fn()} onLightSelect={vi.fn()}
      onLightUpdate={vi.fn()} onLightTransform={vi.fn()} onLightRemove={vi.fn()} onEnvironmentOpen={vi.fn()}
      onPrimitiveRemove={vi.fn()} onMeasurementRemove={vi.fn()} onAnnotationUpdate={vi.fn()} onAnnotationRemove={vi.fn()}
      onSpaceFocus={vi.fn()} onSpaceVisibilityChange={vi.fn()} onSelectGroup={vi.fn()} onRenameGroup={vi.fn()}
      onGroupVisibilityChange={vi.fn()} onGroupLockChange={vi.fn()}
    />);

    expect(html).toContain("scene-layer-group-row");
    expect(html).toContain("泵房设备");
    expect(html.indexOf("根模型")).toBeLessThan(html.indexOf("泵房设备"));
    expect(html).toContain('data-layer-order="[&quot;root-model&quot;,&quot;pump&quot;]"');
    expect(html.match(/循环泵/g)).toHaveLength(1);
    expect(html).not.toContain("scene-organization-panel");
    expect(html).toContain("隔离当前基础元素");
    expect(html).toContain("开启碰撞检测");
    expect(html).toContain("scene-row-selection-mark");
    expect(html).toContain("Shift 连续选择");
    expect(html).not.toContain("单击选择，再次单击取消");
  });
});
