import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SceneSelectionBar } from "./SceneSelectionBar";

describe("SceneSelectionBar", () => {
  it("keeps selection-only actions visible and secondary batch actions in overflow", () => {
    const noop = () => undefined;
    const html = renderToStaticMarkup(
      <SceneSelectionBar
        locale="zh-CN"
        selectedObjects={[{ id: "one" }, { id: "two" }]}
        onGroup={noop}
        onShow={noop}
        onLock={noop}
        onUnlock={noop}
        onIsolate={noop}
        onRestoreIsolation={noop}
        isolationActive
        onCollision={noop}
        onClear={noop}
      />,
    );

    expect(html).toContain("更多所选对象操作");
    expect(html).toContain("编组所选对象");
    expect(html).toContain("隔离所选对象");
    expect(html).toContain("恢复隔离前状态");
    expect(html).toContain("开启所选对象碰撞");
    expect(html).toContain("解锁所选对象");
  });
});
