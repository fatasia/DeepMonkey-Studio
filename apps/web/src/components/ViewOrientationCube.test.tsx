import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { nearestCubeFace, ViewOrientationCube } from "./ViewOrientationCube";

describe("ViewOrientationCube", () => {
  it("renders drag guidance and compact accessible fit actions", () => {
    const html = renderToStaticMarkup(
      <ViewOrientationCube
        locale="zh-CN"
        azimuthDeg={0}
        elevationDeg={20}
        hasSelection={false}
        onStandardView={() => undefined}
        onFitAll={() => undefined}
        onFitSelected={() => undefined}
        onOptimizeView={() => undefined}
      />,
    );
    expect(html).toContain("拖动旋转魔方");
    expect(html).toContain("优化视角");
    expect(html).toContain("请先选择模型");
    expect(html).toContain("适应整个场景");
  });

  it("chooses the face facing the viewer after cube dragging", () => {
    expect(nearestCubeFace(0, 0).view).toBe("front");
    expect(nearestCubeFace(0, -90).view).toBe("right");
    expect(nearestCubeFace(-90, 0).view).toBe("top");
    expect(nearestCubeFace(0, 180).view).toBe("back");
  });
});
