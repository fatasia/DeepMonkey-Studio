import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TopologyMiniature } from "./TopologyMiniature";

describe("topology miniature", () => {
  it("shows actual positions and only valid relationships without mutating the document", () => {
    const topology = { id: "t", name: "t", nodes: [
      { id: "a", kind: "source", x: -100, y: -100, properties: { label: "入口" } },
      { id: "b", kind: "sink", x: 500, y: 0, properties: { label: "出口" } },
    ], edges: [{ id: "ab", sourceNodeId: "a", targetNodeId: "b", properties: {} }, { id: "broken", sourceNodeId: "a", targetNodeId: "missing", properties: {} }] };
    const before = JSON.stringify(topology);
    const html = renderToStaticMarkup(<TopologyMiniature topology={topology} />);
    expect(html).toContain('data-node="a"');
    expect(html).toContain('data-edge="ab"');
    expect(html).not.toContain('data-edge="broken"');
    expect(html).toContain("入口");
    expect(html).not.toMatch(/NaN|Infinity/);
    expect(JSON.stringify(topology)).toBe(before);
  });
  it("keeps empty and co-located graphs finite and bounds very large previews", () => {
    for (const count of [0, 1, 300]) {
      const html = renderToStaticMarkup(<TopologyMiniature topology={{ id: "t", name: "t", edges: [], nodes: Array.from({ length: count }, (_, i) => ({ id: `${i}`, kind: "device", x: 0, y: 0, properties: {} })) }} />);
      expect(html).not.toMatch(/NaN|Infinity/);
      expect(html.match(/data-node=/g)?.length ?? 0).toBe(Math.min(250, count));
    }
  });
});
