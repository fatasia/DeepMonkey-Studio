import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { proposeSmartAssetBindings } from "@bim-studio/studio-core";
import { SmartAssetBindingResults } from "./SmartAssetBindingResults";
import { SmartAssetBindingWorkbench } from "./SmartAssetBindingWorkbench";
import { buildSmartBindingWorkbenchView, candidateKey } from "./smartAssetBindingWorkbenchModel";

describe("SmartAssetBindingWorkbench", () => {
  it("states the human confirmation boundary and provides an actionable empty state", () => {
    const html = renderToStaticMarkup(
      <SmartAssetBindingWorkbench locale="zh-CN" components={[]} onConfirm={vi.fn()} />,
    );

    expect(html).toContain("设备与测点智能绑定");
    expect(html).toContain("人工确认 · 随场景保存");
    expect(html).toContain("先导入模型或创建设备对象");
    expect(html).toContain("进入确认");
  });

  it("renders four review groups and expandable five-factor evidence", () => {
    const scenes = [{ id: "P-101", name: "循环泵 101", category: "泵", properties: { space: "一层" }, position: { x: 0, y: 0 } }];
    const catalog = [{ deviceId: "P-101", name: "循环泵 101", category: "泵", space: "一层", position: { x: 1, y: 0 } }];
    const result = proposeSmartAssetBindings(scenes, catalog);
    const view = buildSmartBindingWorkbenchView(result, scenes, catalog);
    const html = renderToStaticMarkup(
      <SmartAssetBindingResults
        locale="zh-CN"
        view={view}
        selectedKeys={new Set(view.strongCandidates.map(candidateKey))}
        onToggle={vi.fn()}
      />,
    );

    expect(html).toContain("强候选");
    expect(html).toContain("待复核");
    expect(html).toContain("冲突");
    expect(html).toContain("未匹配");
    expect(html).toContain("查看五因子证据");
    expect(html).toContain("稳定标识");
    expect(html).toContain("距离");
    expect(html).toContain('checked=""');
  });
});
