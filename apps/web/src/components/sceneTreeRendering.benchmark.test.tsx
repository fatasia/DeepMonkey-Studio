import { performance } from "node:perf_hooks";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WindowedSceneRows } from "./WindowedSceneRows";
import { ModelTreeItem } from "./ModelTreeItem";
import type { ModelRecord } from "@bim-studio/contracts";

describe("real model row server rendering baseline (not browser timing)", () => {
  it("records 1000/10000 row markup cost with identical ModelTreeItem actions", () => {
    const results = [];
    for (const count of [1000, 10000]) for (const enabled of [false, true]) {
      const rows = Array.from({ length: count }, (_, index) => ({ key: `asset:${index}`, render: () => <ModelTreeItem locale="zh-CN" model={{ id: String(index), name: `设备 ${index}`, format: "glb", status: "ready" } as ModelRecord} loaded={undefined} tree={undefined} expanded={false} modelFloors={[]} floorExpansion={0} selectedModelId={undefined} selectedLayerId={undefined} engine={undefined} onToggleTree={() => {}} onLoadModel={() => {}} onSetRevision={() => {}} onExpandFloors={() => {}} onUpdateFloor={() => {}} onRemoveObjectInteractions={() => {}} onSetMessage={() => {}} onDeleteModel={() => {}} /> }));
      const start = performance.now(), markup = renderToStaticMarkup(<WindowedSceneRows rows={rows} enabled={enabled} />);
      const elementCount = (markup.match(/<[a-z][^/\s>]*/g) ?? []).length, renderedRows = (markup.match(/data-model-id=/g) ?? []).length;
      results.push({ count, enabled, serverRenderMs: +(performance.now() - start).toFixed(2), elementCount, renderedRows });
      expect(renderedRows).toBe(enabled ? 24 : count);
    }
    console.log("SCENE_TREE_SERVER_BENCHMARK", JSON.stringify(results));
  }, 20_000);
});
