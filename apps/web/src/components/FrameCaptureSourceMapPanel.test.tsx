import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createFrameCaptureRecord } from "@bim-studio/deep-engine";
import { FrameCaptureSourceMapPanel, flattenSourceMaps } from "./FrameCaptureSourceMapPanel";

const record = createFrameCaptureRecord({ frameId: "frame-12", startedAtMs: 10, endedAtMs: 12, passes: [{
  passId: "opaque", kind: "render", reads: ["depth"], writes: ["color"], sourceMapRefs: [
    { moduleId: "material.robot", stage: "fragment", nodeId: "paintBaseColor", generatedLine: 42 },
  ],
}] });

describe("FrameCaptureSourceMapPanel", () => {
  it("flattens captured pass provenance without losing author identity", () => {
    expect(flattenSourceMaps([record])).toMatchObject([{ frameId: "frame-12", passId: "opaque",
      moduleId: "material.robot", nodeId: "paintBaseColor", stage: "fragment", generatedLine: 42 }]);
  });

  it("renders author mappings and keeps unavailable diagnostics explicit", () => {
    const html = renderToStaticMarkup(<FrameCaptureSourceMapPanel locale="zh-CN" available records={[record]} />);
    expect(html).toContain("作者 Source Map");
    expect(html).toContain("material.robot");
    expect(html).toContain("paintBaseColor");
    expect(html).toContain("fragment:42");
    expect(html).toContain("frame-12 · opaque");

    const unavailable = renderToStaticMarkup(<FrameCaptureSourceMapPanel locale="en-US" available={false} records={[]} />);
    expect(unavailable).toContain("normal editing is not recorded");
    expect(unavailable).not.toMatch(/[\u4e00-\u9fff]/);
  });
});

