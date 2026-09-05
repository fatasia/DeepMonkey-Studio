import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SimulationEntityState } from "@bim-studio/contracts";
import { SceneSimulationEntitiesSection } from "./SceneSimulationEntitiesSection";

const entities: SimulationEntityState[] = [
  { id: "f1", kind: "flowLink", fromModelId: "m1", toModelId: "m2" },
  { id: "p1", kind: "path", name: "巡检路径", targetModelId: "m1", points: [[0, 0, 0]], loopMode: "loop", speed: 1 },
];

describe("SceneSimulationEntitiesSection", () => {
  it("lists entities with selection state and hides when empty", () => {
    const html = renderToStaticMarkup(<SceneSimulationEntitiesSection locale="zh-CN" entities={entities} selectedId="p1" onSelect={() => {}} brokenModelIds={new Set()} />);
    expect(html).toContain("巡检路径");
    expect(html).toContain("流程连接");
    expect(html).toContain('aria-selected="true"');
    expect(renderToStaticMarkup(<SceneSimulationEntitiesSection locale="zh-CN" entities={[]} selectedId={undefined} onSelect={() => {}} brokenModelIds={new Set()} />)).toBe("");
  });

  it("flags broken references instead of hiding them", () => {
    const html = renderToStaticMarkup(<SceneSimulationEntitiesSection locale="zh-CN" entities={entities} selectedId={undefined} onSelect={() => {}} brokenModelIds={new Set(["m2"])} />);
    expect(html).toContain("断链");
  });
});
