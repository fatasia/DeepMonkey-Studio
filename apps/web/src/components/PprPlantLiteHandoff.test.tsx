import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PprBopVersionDraft } from "@bim-studio/contracts";
import { PprPlantLiteHandoff } from "./PprPlantLiteHandoff";

describe("PprPlantLiteHandoff", () => {
  it("keeps conversion disabled until target takt is explicit", () => {
    const html = renderToStaticMarkup(<PprPlantLiteHandoff draft={draftWithoutTarget()} busy={false} onCreateDraft={vi.fn()} />);
    expect(html).toContain("请先明确填写正数目标节拍");
    expect(html).toContain("disabled");
  });

  it("explains the derived draft, review boundary and non-running handoff", () => {
    const draft = draftWithoutTarget();
    draft.targetTaktMinutes = 5;
    const html = renderToStaticMarkup(<PprPlantLiteHandoff draft={draft} busy={false} onCreateDraft={vi.fn()} />);
    expect(html).toContain("来料间隔");
    expect(html).toContain("12 件/时");
    expect(html).toContain("可编辑草稿");
    expect(html).toContain("不会自动运行");
    expect(html).toContain("生成仿真草稿");
  });
});

function draftWithoutTarget(): PprBopVersionDraft {
  return {
    planId: "pd-lite-project-1",
    name: "总装工艺",
    components: [{ id: "product-1", name: "整机", kind: "product" }],
    operations: [{ id: "operation-1", name: "装配", standardTimeMinutes: 3, componentRefs: [{ componentId: "product-1", role: "output" }] }],
    precedenceRelations: [],
    resources: [],
    resourceAssignments: [],
  };
}
